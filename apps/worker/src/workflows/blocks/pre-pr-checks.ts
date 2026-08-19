import type { PrePrCheckConfig } from "../../pre-pr-checks/config.js";
import {
  MAX_PRE_PR_FIX_CYCLES,
  PRE_PR_CHECK_BATCH_MAX_MINUTES,
  PRE_PR_REPAIR_MAX_MINUTES,
  collectPrePrRepairStep,
  collectRepoCheckBatchStep,
  formatElapsed,
  formatPrePrCheckFailures,
  startPrePrRepairStep,
  startRepoCheckBatchStep,
  type CollectedRepoCheckBatch,
  type PrePrCheckCommandResult,
  type PrePrCheckFailure,
  type PrePrCheckRunResult,
  type PrePrFixBudgetContext,
  type PrePrPhaseStall,
  type RepoCheckBatchProgress,
} from "../../pre-pr-checks/runner.js";
import type { AgentProtocolResult, PhaseUsage } from "../../sandbox/agents/types.js";
import type { ResolvedHarnessRuntime } from "../../sandbox/harness-runtime.js";
import type { V2InvocationCancellation } from "../../workflow-definition/invocation-context.js";
import {
  RunBudgetError,
  checkRunBudget,
  isRunBudgetError,
  recordBudgetUsage,
  type RunBudgetObservation,
} from "../run-budget.js";
import {
  pollPhaseUntilDone,
  type PhasePollOutcome,
  type PhasePollTuning,
} from "./poll-phase.js";

export interface PrePrChecksOptions {
  sandboxId: string;
  config: PrePrCheckConfig;
  agentKind: "claude" | "codex";
  model: string;
  maxFixCycles?: number;
  /** Run-global budget observer. It replaces the wall-clock deadline this path
   *  used to carry: pollPhaseUntilDone re-reads it on every tick, so the bound
   *  survives a replay instead of being recomputed from Date.now(). */
  observeBudget: (
    requireRemainingDuration?: boolean,
  ) => Promise<RunBudgetObservation>;
  cancellation?: V2InvocationCancellation;
  budget?: PrePrFixBudgetContext;
  runtime?: ResolvedHarnessRuntime;
  arthurTaskId?: string | null;
}

/**
 * Hard ceiling on the ticks one batch poll may append to the run's event log.
 *
 * Generous against the duration cap on purpose: at the ramp below a poll needs
 * roughly 125 ticks to cover a full hour, so this never bites before the time
 * bound does at today's cap. It exists so raising that cap cannot quietly turn
 * into thousands of step records in a run that has lost runs to
 * CORRUPTED_EVENT_LOG before.
 */
const BATCH_POLL_MAX_TICKS = 200;

/** A fresh record for one poll to report what it consumed. */
export function newPhasePollOutcome(): PhasePollOutcome {
  return { elapsedMs: 0, ticks: 0, reason: "finished" };
}

/**
 * How both check modes poll a batch.
 *
 * The ramp is the point: checks that finish in seconds should not pay a full
 * 30s tick of latency, and checks that run for twenty minutes should not pay
 * 40 step records for the privilege. It starts at two seconds, ramps toward the
 * 30s ceiling poll-delay.ts documents, and never past it.
 *
 * `stoppedObservations: 2` is not a nicety. checkPhaseDone reports "stopped"
 * for any failure to reach the sandbox, not only for a sandbox that is gone,
 * and a long batch asks it dozens of times; treating one reading as fatal
 * converts a single transient fault into an abandoned check run.
 */
export function batchPollTuning(outcome: PhasePollOutcome): PhasePollTuning {
  return {
    checkBeforeFirstTick: true,
    initialTickMs: 2_000,
    tickGrowthFactor: 1.6,
    maxTicks: BATCH_POLL_MAX_TICKS,
    stoppedObservations: 2,
    outcome,
  };
}

/**
 * How far the batch cap is allowed to exceed the remaining duration budget.
 *
 * Deliberately positive. If the phase cap expires first, the poll returns
 * "the checks ran for N minutes without finishing" and the run takes the
 * checks-failed branch, when what actually happened is that the run ran out of
 * time and should halt as budget_exceeded. Overshooting by a minute makes the
 * budget observer, which the poll re-reads on every tick, always the one that
 * fires.
 */
const BATCH_CAP_BUDGET_MARGIN_MS = 60_000;

/**
 * The time bound that actually applies to one batch, in milliseconds, and the
 * gate that refuses to start one at all.
 *
 * PRE_PR_CHECK_BATCH_MAX_MINUTES is only a ceiling. What really bounds a batch
 * is the run's remaining duration budget, which is `maxDurationMs` from the
 * definition or else env.JOB_TIMEOUT_MS (workflows/agent.ts, where budgetLimits
 * is built), and therefore varies per deployment and per plan. Deriving the
 * bound from the live observation keeps the two from drifting apart.
 *
 * Milliseconds, not minutes: flooring to a whole minute discards up to 59
 * seconds of budget and hands the poll a cap that is always at or below the
 * budget, so the phase timeout systematically pre-empts the budget stop.
 *
 * It also throws on an exhausted token or cost budget, before anything is
 * launched. The poll would raise the same error on its first tick, but only
 * after a wrapper had been written, chmodded and started in the sandbox.
 */
export async function batchCapMs(
  observeBudget: PrePrChecksOptions["observeBudget"],
): Promise<number> {
  const observed = await observeBudget(false);
  if (observed.check.status !== "ok") throw new RunBudgetError(observed.check);
  return Math.min(
    PRE_PR_CHECK_BATCH_MAX_MINUTES * 60_000,
    observed.remainingDurationMs + BATCH_CAP_BUDGET_MARGIN_MS,
  );
}

/**
 * Load the dashboard's current Pre-PR check configuration.
 *
 * The version log stays inside this step: pino may only be used inside a
 * "use step", and moving it to workflow scope fails the Vercel build alone,
 * never vitest or a local build.
 */
export async function loadPrePrCheckConfigStep(): Promise<{
  version: number | null;
  config: PrePrCheckConfig;
}> {
  "use step";
  const { getDb } = await import("../../db/client.js");
  const { getCurrentPrePrCheckConfig } = await import("../../pre-pr-checks/store.js");
  const { emptyPrePrCheckConfig } = await import("../../pre-pr-checks/config.js");
  const { logger } = await import("../../lib/logger.js");
  const current = await getCurrentPrePrCheckConfig(getDb());
  logger.info(
    { version: current?.version ?? null },
    "pre_pr_checks_config_version",
  );
  return {
    version: current?.version ?? null,
    config: current?.config ?? emptyPrePrCheckConfig,
  };
}
loadPrePrCheckConfigStep.maxRetries = 0;

/**
 * Run the configured Pre-PR checks, repairing and re-running them up to
 * `maxFixCycles` times.
 *
 * This is plain async orchestration, deliberately NOT a "use step", exactly
 * like pollPhaseUntilDone. Every awaited thing inside it is a short step: a
 * launch, a poll tick, a collect. A client tenant whose checks take ~1124s
 * used to run all of them inside one step invocation, which Vercel kills at
 * 300s; the re-invocation then hit the step's own re-invocation guard and the
 * run died with no recoverable cause. Nothing here may block near that limit
 * again, so no long-running command may ever be awaited from this scope.
 */
export async function runPrePrChecksWithFixes(
  options: PrePrChecksOptions,
): Promise<PrePrCheckRunResult> {
  const maxFixCycles = options.maxFixCycles ?? MAX_PRE_PR_FIX_CYCLES;
  if (options.config.repositories.length === 0) {
    return {
      outcome: "missing_configuration",
      passed: true,
      fixCycles: 0,
      fixCycleUsages: [],
      budgetFailure: null,
      results: [],
      failures: [],
      setupFailed: false,
      summary: "No pre-PR checks configured.",
    };
  }

  let batch = await runCheckBatches(options, 0);
  let fixCycles = 0;
  const fixCycleUsages: Array<PhaseUsage | null> = [];
  let budgetState = options.budget?.state;

  // Three separate reasons never to enter the repair loop, and none of them is
  // a check that failed. A setup failure means the workspace is missing a tool
  // and no edit the fixer can make will install it; before that guard the
  // platform spent its whole fix budget rewriting code in response to "command
  // not found". A stalled batch verified nothing, so there is nothing to hand a
  // fixer. And a run whose only failures are the workspace's own (unreachable
  // directory, foreign output files) has nothing repairable in it either.
  while (
    !batch.passed &&
    !batch.setupFailed &&
    !batch.stalled &&
    batch.hasRepairableFailures &&
    fixCycles < maxFixCycles
  ) {
    fixCycles++;
    const fixer = await runFixCycle(options, batch.repairSummary, fixCycles);
    fixCycleUsages.push(fixer.usage);
    if (fixer.failure) {
      return withFixCycles(batch, fixCycles, fixCycleUsages, null, fixer.failure);
    }
    if (options.budget && budgetState) {
      budgetState = recordBudgetUsage(budgetState, fixer.usage, options.budget.price);
      const check = checkRunBudget(budgetState, options.budget.limits);
      if (check.status !== "ok") {
        return withFixCycles(batch, fixCycles, fixCycleUsages, check);
      }
    }
    batch = await runCheckBatches(options, fixCycles);
  }

  return withFixCycles(batch, fixCycles, fixCycleUsages, null);
}

/** One pass over every configured repository, plus why it ended. */
interface CheckBatchesResult {
  outcome: Exclude<PrePrCheckRunResult["outcome"], "missing_configuration">;
  passed: boolean;
  results: PrePrCheckCommandResult[];
  failures: PrePrCheckFailure[];
  setupFailed: boolean;
  /** True when a repository's batch never reported a result: it outlived its
   *  cap, or the sandbox under it died. Distinct from a failed check. */
  stalled: boolean;
  /** At least one failure a code edit could plausibly repair. Workspace and
   *  setup failures are not among them. */
  hasRepairableFailures: boolean;
  summary: string;
  /** What a fixer is shown: the repairable failures only, so it is never asked
   *  to edit code in response to the run's own infrastructure. */
  repairSummary: string;
}

function withFixCycles(
  batch: CheckBatchesResult,
  fixCycles: number,
  fixCycleUsages: Array<PhaseUsage | null>,
  budgetFailure: PrePrCheckRunResult["budgetFailure"],
  agentFailure?: Extract<AgentProtocolResult<unknown>, { ok: false }>,
): PrePrCheckRunResult {
  return {
    outcome: batch.outcome,
    passed: batch.passed,
    results: batch.results,
    failures: batch.failures,
    setupFailed: batch.setupFailed,
    summary: batch.summary,
    fixCycles,
    fixCycleUsages,
    budgetFailure,
    ...(agentFailure ? { agentFailure } : {}),
  };
}

/** Ordinary check failures: the only kind a repair agent can act on. */
function repairableFailures(failures: PrePrCheckFailure[]): PrePrCheckFailure[] {
  return failures.filter((failure) => failure.phase === undefined);
}

function batchesResult(
  results: PrePrCheckCommandResult[],
  failures: PrePrCheckFailure[],
  setupFailedRepositories: string[],
  ranChecks: number,
  fixCyclesRun: number,
): CheckBatchesResult {
  const repairable = repairableFailures(failures);
  return {
    outcome: failures.length > 0 ? "failed" : "passed",
    passed: failures.length === 0,
    results,
    failures,
    setupFailed: setupFailedRepositories.length > 0,
    stalled: false,
    hasRepairableFailures: repairable.length > 0,
    summary:
      failures.length > 0
        ? formatPrePrCheckFailures(failures, setupFailedRepositories, fixCyclesRun)
        : ranChecks === 0
          ? "No pre-PR checks matched changed repositories."
          : `Pre-PR checks passed (${ranChecks} command${ranChecks === 1 ? "" : "s"}).`,
    repairSummary: formatPrePrCheckFailures(repairable),
  };
}

/** What one repository's batch did, from launch to collected files. */
export interface RepoCheckBatchRun {
  /** The repository was not started: not attached, or unchanged. */
  skipped: boolean;
  collected: CollectedRepoCheckBatch;
  /** Set when the batch never reported: it outlived its bound, or the sandbox
   *  under it went. Whatever `collected` holds is then a partial record. */
  stall: Exclude<PrePrPhaseStall, "none"> | null;
  /** Tick time the poll consumed, for a message that names the real bound. */
  elapsedMs: number;
}

/**
 * Run one repository's batch: launch it detached, poll it across ticks, and
 * read back whatever it wrote.
 *
 * Shared by both check modes. They differ only in where the commands come from
 * and how the result is shaped for their caller; everything between the launch
 * and the collected files (the derived cap, the budget gate, the stall
 * classification, the guarded collect of an abandoned batch) is one behaviour
 * and must not drift into two.
 */
export async function runRepoCheckBatch(args: {
  sandboxId: string;
  provider: PrePrCheckFailure["provider"];
  repoPath: string;
  setup: string[];
  commands: string[];
  fixCycle: number;
  repoIndex: number;
  requireChange: boolean;
  observeBudget: PrePrChecksOptions["observeBudget"];
  cancellation?: V2InvocationCancellation;
}): Promise<RepoCheckBatchRun> {
  const total = args.setup.length + args.commands.length;
  const capMs = await batchCapMs(args.observeBudget);
  const started = await startRepoCheckBatchStep(
    args.sandboxId,
    args.provider,
    args.repoPath,
    args.setup,
    args.commands,
    args.fixCycle,
    args.repoIndex,
    args.requireChange,
  );
  if (started.skipped) {
    return { skipped: true, collected: unreadableBatch(), stall: null, elapsedMs: 0 };
  }

  const collect = (batchFinished: boolean): Promise<CollectedRepoCheckBatch> =>
    collectRepoCheckBatchStep(
      args.sandboxId,
      args.provider,
      args.repoPath,
      args.setup,
      args.commands,
      started.paths,
      started.localPath,
      batchFinished,
    );

  const outcome = newPhasePollOutcome();
  let done: boolean;
  try {
    done = await pollPhaseUntilDone(
      args.sandboxId,
      started.paths.sentinel,
      PRE_PR_CHECK_BATCH_MAX_MINUTES,
      started.commandId,
      args.observeBudget,
      args.cancellation,
      { ...batchPollTuning(outcome), phaseLimitMs: capMs },
    );
  } catch (error) {
    // A budget stop still ends the run, but the wrapper's files say exactly how
    // far the checks got and the operator has no other way to find out.
    throw await budgetErrorNamingProgress(error, args.provider, args.repoPath, collect);
  }

  if (!done) {
    const stall = await resolvePhaseStall(
      args.sandboxId,
      started.paths.sentinel,
      outcome,
    );
    if (stall !== "none") {
      return {
        skipped: false,
        collected: await collectAbandonedBatch(collect),
        stall,
        elapsedMs: outcome.elapsedMs,
      };
    }
  }

  return {
    skipped: false,
    collected: await collect(true),
    stall: null,
    elapsedMs: outcome.elapsedMs,
  };
}

/**
 * Read back a batch the run has already stopped believing.
 *
 * Guarded, because this runs exactly when the sandbox may be gone: the poll
 * gave up, and on the sandbox-death path it did so after observing the sandbox
 * as not running twice. The collect step's maxRetries is 0, so an SDK error
 * escaping here would replace the informative stall sentence with an
 * unclassified failure, in the very case this whole mechanism exists for.
 * Losing the detail is acceptable; losing the diagnosis is not.
 */
async function collectAbandonedBatch(
  collect: (batchFinished: boolean) => Promise<CollectedRepoCheckBatch>,
): Promise<CollectedRepoCheckBatch> {
  try {
    return await collect(false);
  } catch {
    return unreadableBatch();
  }
}

/**
 * A batch with no record: either nothing was started for this repository, or
 * its files could not be read back.
 *
 * `total: 0` is the signal, and formatProgress reads it as "how far it got
 * could not be read back" rather than "0 of 0 commands finished". Inventing a
 * count here would put a number in an operator's failure message that no file
 * in the sandbox supports.
 */
function unreadableBatch(): CollectedRepoCheckBatch {
  return {
    results: [],
    failures: [],
    setupFailed: false,
    progress: { completed: 0, total: 0, stoppedAt: null },
  };
}

async function runCheckBatches(
  options: PrePrChecksOptions,
  fixCycle: number,
): Promise<CheckBatchesResult> {
  const results: PrePrCheckCommandResult[] = [];
  const failures: PrePrCheckFailure[] = [];
  const setupFailedRepositories: string[] = [];
  let ranChecks = 0;

  for (const [repoIndex, repo] of uniqueConfiguredRepositories(options.config).entries()) {
    const run = await runRepoCheckBatch({
      sandboxId: options.sandboxId,
      provider: repo.provider,
      repoPath: repo.repoPath,
      setup: repo.setup ?? [],
      commands: repo.commands,
      fixCycle,
      repoIndex,
      requireChange: true,
      observeBudget: options.observeBudget,
      cancellation: options.cancellation,
    });
    if (run.skipped) continue;
    if (run.stall) {
      return stalledBatches(
        repo.provider,
        repo.repoPath,
        run.stall,
        run.elapsedMs,
        run.collected,
        results,
        failures,
        setupFailedRepositories,
        fixCycle,
      );
    }

    results.push(...run.collected.results);
    failures.push(...run.collected.failures);
    ranChecks += run.collected.results.length;
    if (run.collected.setupFailed) {
      setupFailedRepositories.push(`${repo.provider}:${repo.repoPath}`);
    }
  }

  return batchesResult(results, failures, setupFailedRepositories, ranChecks, fixCycle);
}

/**
 * Configured repositories deduplicated by provider and path, the last entry
 * winning.
 *
 * The blocking runner keyed the configuration into a Map before walking the
 * workspace, so a duplicate entry only ever ran its last occurrence. Walking
 * the configuration directly would run both, and running one repository's
 * batch twice doubles a wall clock measured in tens of minutes.
 */
function uniqueConfiguredRepositories(
  config: PrePrCheckConfig,
): PrePrCheckConfig["repositories"] {
  return [
    ...new Map(
      config.repositories.map((repo) => [`${repo.provider}:${repo.repoPath}`, repo]),
    ).values(),
  ];
}

/**
 * Why a poll ended without a sentinel.
 *
 * The reason comes from the poll itself, which knows whether it ran out of
 * ticks or saw the sandbox go: guessing it from one more sentinel read would
 * call every failure to reach the sandbox a dead sandbox. That read is still
 * made, for one thing only: the sentinel may have appeared between the poll's
 * last tick and now, and a finished batch must not be reported as a stall.
 *
 * Shared with the explicit-commands mode of run_checks, which has no fix loop
 * to suppress but the same rule about never reading a stall as a pass.
 */
export async function resolvePhaseStall(
  sandboxId: string,
  sentinelFile: string,
  outcome: PhasePollOutcome,
): Promise<PrePrPhaseStall> {
  const { checkPhaseDone } = await import("../../sandbox/poll-agent.js");
  if ((await checkPhaseDone(sandboxId, sentinelFile)) === true) return "none";
  return outcome.reason === "sandbox_stopped" ? "sandbox_stopped" : "timed_out";
}

/** Where the batch got to, named from the files the wrapper actually wrote. */
function formatProgress(progress: RepoCheckBatchProgress): string {
  // total 0 is the unreadable-batch marker, not a batch of no commands: the
  // files could not be read, so any count would be invented.
  if (progress.total === 0) return "; how far it got could not be read back";
  const counted = `${progress.completed} of ${progress.total} command${
    progress.total === 1 ? "" : "s"
  } had finished`;
  return progress.stoppedAt
    ? ` while running \`${progress.stoppedAt}\`; ${counted}`
    : `; ${counted}`;
}

/**
 * The sentence a stalled batch reports, in either check mode.
 *
 * It states the time that actually elapsed, never the cap that was requested: a
 * poll can end early, the cap itself is derived from the remaining budget, and
 * a message that can be false is worse than no message.
 */
export function batchStallReason(
  stall: Exclude<PrePrPhaseStall, "none">,
  elapsedMs: number,
  progress: RepoCheckBatchProgress,
): string {
  const where = formatProgress(progress);
  return stall === "sandbox_stopped"
    ? `The Run Workspace sandbox stopped while this repository's checks were running${where}. ` +
        "Nothing was verified: this is a lost workspace, not a failing check."
    : `The checks for this repository ran for ${formatElapsed(elapsedMs)} without finishing and ` +
        `were stopped${where}. Nothing was verified: this is a timeout, not a passing or a ` +
        "failing check result.";
}

/**
 * A stalled batch fails the checks and abandons the pass. It stops the walk
 * too: a sandbox that died or a batch that outlived its cap makes every later
 * repository's result meaningless.
 *
 * What the batch did manage is still reported. Those commands really ran, and
 * the operator needs them to see where it stopped.
 */
function stalledBatches(
  provider: PrePrCheckFailure["provider"],
  repoPath: string,
  stall: Exclude<PrePrPhaseStall, "none">,
  elapsedMs: number,
  collected: CollectedRepoCheckBatch,
  results: PrePrCheckCommandResult[],
  failures: PrePrCheckFailure[],
  /** Repositories earlier in this same pass whose setup failed. Carried so a
   *  stall cannot quietly report setupFailed: false next to a summary that
   *  says SETUP FAILED. */
  setupFailedRepositories: string[],
  fixCyclesRun: number,
): CheckBatchesResult {
  const stallFailure: PrePrCheckFailure = {
    provider,
    repoPath,
    command: collected.progress.stoppedAt ?? "(pre-PR check batch)",
    exitCode: -1,
    stdout: "",
    stderr: batchStallReason(stall, elapsedMs, collected.progress),
    // The batch never reported, so this is not a check result at all. Without a
    // phase it reads as an ordinary failing check: it would be handed to the
    // repair agent, and under a setup failure elsewhere it would collect the
    // sentence saying its fix cycles were suppressed, when the reason nothing
    // was fixed is that nothing was verified.
    phase: "batch",
  };
  const allResults = [...results, ...collected.results];
  const allFailures = [...failures, ...collected.failures, stallFailure];
  return {
    outcome: "failed",
    passed: false,
    results: allResults,
    failures: allFailures,
    setupFailed: setupFailedRepositories.length > 0,
    stalled: true,
    hasRepairableFailures: false,
    summary: formatPrePrCheckFailures(allFailures, setupFailedRepositories, fixCyclesRun),
    repairSummary: "",
  };
}

/**
 * Attach how far the checks got to a budget stop, then hand it back for the
 * caller to throw. Anything that is not a budget failure is returned untouched.
 */
export async function budgetErrorNamingProgress(
  error: unknown,
  provider: PrePrCheckFailure["provider"],
  repoPath: string,
  collect: (batchFinished: boolean) => Promise<CollectedRepoCheckBatch>,
): Promise<unknown> {
  if (!isRunBudgetError(error)) return error;
  // Guarded for the same reason the stall path is: this reads a sandbox the run
  // is already leaving, and a throw here would replace the budget stop with an
  // unclassified failure, which is worse than a budget stop with no detail.
  const collected = await collectAbandonedBatch(collect);
  return new RunBudgetError({
    ...error.failure,
    reason:
      `${error.failure.reason}; checks for ${provider}:${repoPath} stopped` +
      `${formatProgress(collected.progress)}`,
  });
}

async function runFixCycle(
  options: PrePrChecksOptions,
  failureSummary: string,
  fixCycle: number,
): Promise<{
  usage: PhaseUsage | null;
  failure?: Extract<AgentProtocolResult<unknown>, { ok: false }>;
}> {
  const started = await startPrePrRepairStep(
    options.sandboxId,
    options.agentKind,
    options.model,
    fixCycle,
    failureSummary,
    options.runtime,
    options.arthurTaskId,
  );
  if (!started.ok) return { usage: null, failure: started.failure };

  // The repair agent is polled across ticks for the same reason the checks are:
  // waiting for it inside the step that launched it caps the phase at one
  // function invocation.
  const outcome = newPhasePollOutcome();
  const done = await pollPhaseUntilDone(
    options.sandboxId,
    started.paths.sentinel,
    PRE_PR_REPAIR_MAX_MINUTES,
    started.commandId,
    options.observeBudget,
    options.cancellation,
    {
      ...batchPollTuning(outcome),
      phaseLimitMs: Math.min(
        PRE_PR_REPAIR_MAX_MINUTES * 60_000,
        await batchCapMs(options.observeBudget),
      ),
    },
  );
  const stall = done
    ? "none"
    : await resolvePhaseStall(options.sandboxId, started.paths.sentinel, outcome);
  return collectPrePrRepairStep(
    options.sandboxId,
    options.agentKind,
    started.phase,
    started.paths,
    stall,
    outcome.elapsedMs,
    options.runtime,
  );
}
