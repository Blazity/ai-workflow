import type {
  PrePrCheckConfig,
  RepoScriptsConfig,
  RepoScriptsRepositoryConfig,
} from "../../pre-pr-checks/config.js";
export { MAX_PRE_PR_FIX_CYCLES } from "../../pre-pr-checks/runner.js";
import {
  PRE_PR_CHECK_BATCH_MAX_MINUTES,
  collectRepoCheckBatchStep,
  formatElapsed,
  formatPrePrCheckFailures,
  startRepoCheckBatchStep,
  type CollectedRepoCheckBatch,
  type PrePrCheckCommandResult,
  type PrePrCheckFailure,
  type PrePrCheckRunResult,
  type PrePrFixBudgetContext,
  type PrePrPhaseStall,
  type RepoCheckBatchProgress,
  type RepoScriptsDirtiedRepo,
  type RepoScriptsGroupStatus,
  type RepoScriptsGroupStatusEntry,
} from "../../pre-pr-checks/runner.js";
import type { ResolvedHarnessRuntime } from "../../sandbox/harness-runtime.js";
import type { V2InvocationCancellation } from "../../workflow-definition/invocation-context.js";
import {
  RunBudgetError,
  isRunBudgetError,
  type RunBudgetObservation,
} from "../run-budget.js";
import {
  pollPhaseUntilDone,
  type PhasePollOutcome,
  type PhasePollTuning,
} from "./poll-phase.js";

/**
 * Which of a repository's script groups one run executes.
 *
 * `gate` is the publication gate's own selection: the groups the configuration
 * marked as gating, or all of them. `named` is a graph node asking for groups
 * by name, and it intersects with what each repository actually declares, so
 * one node can ask for "test" across a workspace where only some repositories
 * have it.
 */
export type RepoScriptsGroupSelection =
  | { kind: "gate" }
  | { kind: "named"; groups: string[] };

export interface PrePrChecksOptions {
  sandboxId: string;
  /**
   * The RAW stored configuration, exactly as loadPrePrCheckConfigStep returned
   * it.
   *
   * Deliberately unknown: this is the engine boundary, and parsing happens here
   * rather than at the load step because the workspace gate fingerprints the
   * raw stored value. Normalizing before the fingerprint is computed would
   * change what the gate hashes and silently invalidate every recorded gate.
   */
  config: unknown;
  /** @deprecated The repair loop is gone; nothing launches an agent from here. */
  agentKind: "claude" | "codex";
  /** @deprecated As agentKind. */
  model: string;
  /** @deprecated Ignored: the fix loop it bounded no longer exists. Kept until
   *  stage 3 removes the graph param that feeds it. */
  maxFixCycles?: number;
  /** Groups to run. Defaults to the gate's own selection. */
  groupSelection?: RepoScriptsGroupSelection;
  /** Run-global budget observer. It replaces the wall-clock deadline this path
   *  used to carry: pollPhaseUntilDone re-reads it on every tick, so the bound
   *  survives a replay instead of being recomputed from Date.now(). */
  observeBudget: (
    requireRemainingDuration?: boolean,
  ) => Promise<RunBudgetObservation>;
  cancellation?: V2InvocationCancellation;
  /** @deprecated Only the repair agent spent tokens from this path. */
  budget?: PrePrFixBudgetContext;
  /** @deprecated As budget. */
  runtime?: ResolvedHarnessRuntime;
  /** @deprecated As budget. */
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
  /** The configuration's own ceiling, when it sets one. It may sit above
   *  PRE_PR_CHECK_BATCH_MAX_MINUTES: an operator who raises it has said what
   *  their batch really costs, and the run's duration budget still bounds it. */
  maxMinutes = PRE_PR_CHECK_BATCH_MAX_MINUTES,
): Promise<number> {
  const observed = await observeBudget(false);
  if (observed.check.status !== "ok") throw new RunBudgetError(observed.check);
  return Math.min(
    maxMinutes * 60_000,
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
 * Run the configured repository scripts once, over every configured repository.
 *
 * This is plain async orchestration, deliberately NOT a "use step", exactly
 * like pollPhaseUntilDone. Every awaited thing inside it is a short step: a
 * launch, a poll tick, a collect. A client tenant whose checks take ~1124s
 * used to run all of them inside one step invocation, which Vercel kills at
 * 300s; the re-invocation then hit the step's own re-invocation guard and the
 * run died with no recoverable cause. Nothing here may block near that limit
 * again, so no long-running command may ever be awaited from this scope.
 *
 * One pass, never a loop. The repair loop this used to run is gone: it hid
 * failing checks behind an agent's edits, and it could not tell a broken
 * environment from broken code. See MAX_PRE_PR_FIX_CYCLES.
 */
export async function runPrePrChecksWithFixes(
  options: PrePrChecksOptions,
): Promise<PrePrCheckRunResult> {
  // Imported here rather than statically, like every other import this module
  // makes from outside workflow scope: the module is bundled for the workflow
  // and a static import graph that reaches a Node builtin fails the Vercel
  // build alone, never vitest or a local build.
  const { repoScriptsConfigSchema, describePrePrCheckIssues } = await import(
    "../../pre-pr-checks/config.js"
  );
  const parsed = repoScriptsConfigSchema.safeParse(options.config);
  if (!parsed.success) {
    // Loud, never silent. Treating an unparseable configuration as "no checks
    // configured" reads as a pass, and the gate would then record a green
    // verdict for a repository nothing verified. It is also not thrown: the
    // checks are workflow scope now, so a throw here leaves the run with an
    // unclassified failure instead of a summary naming the broken field.
    return emptyRunResult({
      outcome: "failed",
      passed: false,
      summary:
        "The repository scripts configuration could not be read, so nothing ran: " +
        `${describePrePrCheckIssues(parsed.error)}. Fix it in the dashboard and re-run.`,
    });
  }

  const config = parsed.data;
  if (config.repositories.length === 0) {
    return emptyRunResult({
      outcome: "missing_configuration",
      passed: true,
      summary: NO_CONFIGURATION_SUMMARY,
    });
  }

  const batch = await runCheckBatches(options, config);
  return {
    outcome: batch.outcome,
    passed: batch.passed,
    results: batch.results,
    failures: batch.failures,
    groupStatuses: batch.groupStatuses,
    dirtied: batch.dirtied,
    setupFailed: batch.setupFailed,
    summary: batch.summary,
    fixCycles: 0,
    fixCycleUsages: [],
    budgetFailure: null,
  };
}

/** A result with nothing in it: no repository ran, and the summary says why. */
function emptyRunResult(shape: {
  outcome: PrePrCheckRunResult["outcome"];
  passed: boolean;
  summary: string;
}): PrePrCheckRunResult {
  return {
    ...shape,
    fixCycles: 0,
    fixCycleUsages: [],
    budgetFailure: null,
    results: [],
    failures: [],
    groupStatuses: [],
    dirtied: [],
    setupFailed: false,
  };
}

/** One pass over every configured repository, plus why it ended. */
interface CheckBatchesResult {
  outcome: Exclude<PrePrCheckRunResult["outcome"], "missing_configuration">;
  passed: boolean;
  results: PrePrCheckCommandResult[];
  failures: PrePrCheckFailure[];
  groupStatuses: RepoScriptsGroupStatusEntry[];
  dirtied: RepoScriptsDirtiedRepo[];
  setupFailed: boolean;
  summary: string;
}

/**
 * Every summary this engine can produce, in one place.
 *
 * The vocabulary is "repository scripts", not "pre-PR checks": the same engine
 * now runs groups a graph node picked by name, and a node that ran the `lint`
 * group has nothing to do with a pull request. The gate sentence is the one
 * exception and it is kept, because "matched changed repositories" describes
 * something only the gate does: a named selection deliberately runs whether or
 * not a repository changed, so telling its operator that nothing matched a
 * change would name a filter that was never applied.
 */
const NO_CONFIGURATION_SUMMARY = "No repository scripts configured.";

function nothingRanSummary(selection: RepoScriptsGroupSelection): string {
  return selection.kind === "gate"
    ? "No repository scripts matched changed repositories."
    : "No repository scripts matched the selected groups.";
}

function passedSummary(ranChecks: number): string {
  return `Repository scripts passed (${ranChecks} command${ranChecks === 1 ? "" : "s"}).`;
}

function batchesResult(
  results: PrePrCheckCommandResult[],
  failures: PrePrCheckFailure[],
  groupStatuses: RepoScriptsGroupStatusEntry[],
  dirtied: RepoScriptsDirtiedRepo[],
  setupFailedRepositories: string[],
  ranChecks: number,
  selection: RepoScriptsGroupSelection,
): CheckBatchesResult {
  return {
    outcome: failures.length > 0 ? "failed" : "passed",
    passed: failures.length === 0,
    results,
    failures,
    groupStatuses,
    dirtied,
    setupFailed: setupFailedRepositories.length > 0,
    summary:
      failures.length > 0
        ? formatPrePrCheckFailures(failures)
        : ranChecks === 0
          ? nothingRanSummary(selection)
          : passedSummary(ranChecks),
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
  /** Group each command belongs to, parallel to `commands`. Absent for the
   *  explicit-commands mode of run_checks, which authors no groups. */
  commandGroups?: string[];
  /** Worker env var NAMES this repository declared. Values never travel here. */
  envNames?: string[];
  /** The repository's own per-command bound, in minutes, if it set one. */
  commandTimeoutMinutes?: number;
  /** The configuration's own whole-batch ceiling, if it set one. */
  batchTimeoutMinutes?: number;
  /**
   * Whether the batch puts back the tracked files its commands modified.
   *
   * Per repository rather than per group, because a batch cannot attribute a
   * file change to the command that made it: the selection restores only when
   * EVERY selected group restores, so adding one formatter group to a run
   * leaves the whole repository's edits in place. That is the conservative
   * direction, nothing is ever thrown away, but it is a real sharp edge in a
   * mixed selection and it is documented on the config field as well.
   */
  restoreTree?: boolean;
}): Promise<RepoCheckBatchRun> {
  const total = args.setup.length + args.commands.length;
  const maxMinutes = args.batchTimeoutMinutes ?? PRE_PR_CHECK_BATCH_MAX_MINUTES;
  const capMs = await batchCapMs(args.observeBudget, maxMinutes);
  const started = await startRepoCheckBatchStep(
    args.sandboxId,
    args.provider,
    args.repoPath,
    args.setup,
    args.commands,
    args.fixCycle,
    args.repoIndex,
    args.requireChange,
    {
      ...(args.envNames ? { envNames: args.envNames } : {}),
      ...(args.commandTimeoutMinutes === undefined
        ? {}
        : { commandTimeoutMinutes: args.commandTimeoutMinutes }),
      ...(args.restoreTree === undefined ? {} : { restoreTree: args.restoreTree }),
    },
  );
  if (started.skipped) {
    return { skipped: true, collected: unreadableBatch(), stall: null, elapsedMs: 0 };
  }
  if (started.envFailure) {
    // Nothing was launched, so there is nothing to poll or collect. The count
    // is real rather than the unreadable-batch marker: we know exactly how many
    // commands this repository had and that none of them started.
    return {
      skipped: false,
      collected: {
        results: [],
        failures: [started.envFailure],
        setupFailed: false,
        dirtied: [],
        preExistingDirty: [],
        setupMarkerFailed: false,
        progress: { completed: 0, total, stoppedAt: null },
      },
      stall: null,
      elapsedMs: 0,
    };
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
      {
        ...(args.commandGroups ? { commandGroups: args.commandGroups } : {}),
        ...(args.envNames ? { envNames: args.envNames } : {}),
        ...(args.commandTimeoutMinutes === undefined
          ? {}
          : { commandTimeoutMinutes: args.commandTimeoutMinutes }),
      },
    );

  const outcome = newPhasePollOutcome();
  let done: boolean;
  try {
    done = await pollPhaseUntilDone(
      args.sandboxId,
      started.paths.sentinel,
      maxMinutes,
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
    dirtied: [],
    preExistingDirty: [],
    setupMarkerFailed: false,
    progress: { completed: 0, total: 0, stoppedAt: null },
  };
}

/** One repository's commands, each tagged with the group it is being run for. */
interface RepoCommandPlan {
  command: string;
  group: string;
}

/**
 * Which groups this run executes for one repository, and the commands that
 * come out of them.
 *
 * A named selection intersects with what the repository declares rather than
 * failing on a missing group: one node asking for "test" across a workspace
 * where only two of five repositories define it is the normal case, not an
 * error. A repository with none of the requested groups runs nothing at all.
 */
async function planRepository(
  repo: RepoScriptsRepositoryConfig,
  selection: RepoScriptsGroupSelection,
): Promise<{
  selectedGroups: string[];
  plan: RepoCommandPlan[];
  /** Each selected group's FULL expansion, before deduplication across groups. */
  groupCommands: Map<string, string[]>;
}> {
  const { expandGroupCommands, resolveGateGroups } = await import(
    "../../pre-pr-checks/config.js"
  );
  const selectedGroups =
    selection.kind === "gate"
      ? resolveGateGroups(repo)
      : selection.groups.filter((group) => group in repo.groups);

  // Two different things, and collapsing them is a false pass.
  //
  // `plan` is what RUNS: one entry per distinct command, so a command two
  // selected groups share is executed once, and it is attributed to the first
  // group that asked for it. `groupCommands` is what each group MEANS: its
  // whole expansion, shared commands included. A group is judged on the second,
  // because `test` extending `deps` is only green if the dependency install it
  // depends on was green, whoever happened to run it. Judging on the first
  // reported such a group as passed while its own dependency step had failed.
  const seen = new Set<string>();
  const plan: RepoCommandPlan[] = [];
  const groupCommands = new Map<string, string[]>();
  for (const group of selectedGroups) {
    const commands = expandGroupCommands(repo, [group]);
    groupCommands.set(group, commands);
    for (const command of commands) {
      if (seen.has(command)) continue;
      seen.add(command);
      plan.push({ command, group });
    }
  }
  return { selectedGroups, plan, groupCommands };
}

/**
 * What each of a repository's groups did.
 *
 * Judged over the group's FULL expansion, not over the commands the plan
 * happened to attribute to it: a shared command runs once and its single
 * result counts for every group that includes it. `deps` failing therefore
 * fails `lint` and `test` as well, which is the only honest answer when both
 * of them declared they need it.
 *
 * The results are matched by command text, which is exact here because the
 * expansion deduplicates within a repository, so one repository never runs the
 * same command string twice. A group the run did not select, and every group of
 * a repository that never started, is `skipped`.
 */
function groupStatusesFor(
  repo: RepoScriptsRepositoryConfig,
  selectedGroups: string[],
  groupCommands: Map<string, string[]>,
  collected: CollectedRepoCheckBatch | null,
): RepoScriptsGroupStatusEntry[] {
  const resultOf = new Map(
    (collected?.results ?? []).map((result) => [result.command, result]),
  );
  // A timed-out command also produces a failure entry, so it has to be taken
  // back out here or every timeout would be reported as a plain failure and
  // the distinction the status union exists for would never appear.
  const timedOutCommands = new Set(
    (collected?.results ?? [])
      .filter((result) => result.timedOut)
      .map((result) => result.command),
  );
  const failedCommands = new Set(
    (collected?.failures ?? [])
      .filter((failure) => failure.phase === undefined)
      .map((failure) => failure.command)
      .filter((command) => !timedOutCommands.has(command)),
  );

  return Object.keys(repo.groups).map((group) => {
    const status = ((): RepoScriptsGroupStatus => {
      if (collected === null || !selectedGroups.includes(group)) return "skipped";
      const commands = groupCommands.get(group) ?? [];
      const ran = commands
        .map((command) => resultOf.get(command))
        .filter((result): result is PrePrCheckCommandResult => result !== undefined);
      // `failed` before `timed_out`, deliberately. A group with one command
      // that failed and another that ran out of time has a real verdict on its
      // code, and reporting only the timeout hides it behind an infrastructure
      // story an operator answers by raising a bound.
      if (
        ran.some((result) => result.exitCode !== 0 && !result.timedOut) ||
        commands.some((command) => failedCommands.has(command))
      ) {
        return "failed";
      }
      if (ran.some((result) => result.timedOut)) return "timed_out";
      // Never a pass on a partial run: a group whose batch was abandoned
      // halfway verified nothing about the commands that never started, and a
      // false pass on this gate is the worst outcome this system has.
      return ran.length === commands.length ? "passed" : "not_run";
    })();
    return { provider: repo.provider, repoPath: repo.repoPath, group, status };
  });
}

async function runCheckBatches(
  options: PrePrChecksOptions,
  config: RepoScriptsConfig,
): Promise<CheckBatchesResult> {
  const results: PrePrCheckCommandResult[] = [];
  const failures: PrePrCheckFailure[] = [];
  const groupStatuses: RepoScriptsGroupStatusEntry[] = [];
  const dirtied: RepoScriptsDirtiedRepo[] = [];
  const setupFailedRepositories: string[] = [];
  const selection = options.groupSelection ?? { kind: "gate" };
  let ranChecks = 0;

  for (const [repoIndex, repo] of uniqueConfiguredRepositories(config).entries()) {
    const { selectedGroups, plan, groupCommands } = await planRepository(repo, selection);
    if (selectedGroups.length === 0) {
      // This run asked for groups this repository does not have, so it is not
      // part of the run at all. Nothing is launched and nothing is claimed.
      groupStatuses.push(...groupStatusesFor(repo, selectedGroups, groupCommands, null));
      continue;
    }

    const run = await runRepoCheckBatch({
      sandboxId: options.sandboxId,
      provider: repo.provider,
      repoPath: repo.repoPath,
      setup: repo.setup ?? [],
      commands: plan.map((entry) => entry.command),
      commandGroups: plan.map((entry) => entry.group),
      fixCycle: 0,
      repoIndex,
      // The gate only has to verify what changed, so an untouched repository is
      // skipped. A named selection is a graph node asking for a group by name,
      // and its contract is to run wherever the group exists: skipping a
      // repository the agent did not happen to touch would silently answer
      // "run the tests" with no tests at all.
      requireChange: selection.kind === "gate",
      restoreTree: selectedGroups.every(
        (group) => repo.groups[group]?.restoreTree !== false,
      ),
      observeBudget: options.observeBudget,
      cancellation: options.cancellation,
      ...(repo.env && repo.env.length > 0 ? { envNames: repo.env } : {}),
      ...(repo.commandTimeoutMinutes === undefined
        ? {}
        : { commandTimeoutMinutes: repo.commandTimeoutMinutes }),
      ...(config.batchTimeoutMinutes === undefined
        ? {}
        : { batchTimeoutMinutes: config.batchTimeoutMinutes }),
    });
    if (run.skipped) {
      groupStatuses.push(...groupStatusesFor(repo, selectedGroups, groupCommands, null));
      continue;
    }
    groupStatuses.push(
      ...groupStatusesFor(repo, selectedGroups, groupCommands, run.collected),
    );
    if (run.collected.dirtied.length > 0 || run.collected.preExistingDirty.length > 0) {
      dirtied.push({
        provider: repo.provider,
        repoPath: repo.repoPath,
        files: run.collected.dirtied,
        preExisting: run.collected.preExistingDirty,
      });
    }
    if (run.stall) {
      return stalledBatches(
        repo.provider,
        repo.repoPath,
        run.stall,
        run.elapsedMs,
        run.collected,
        results,
        failures,
        groupStatuses,
        dirtied,
        setupFailedRepositories,
      );
    }

    results.push(...run.collected.results);
    failures.push(...run.collected.failures);
    ranChecks += run.collected.results.length;
    if (run.collected.setupFailed) {
      setupFailedRepositories.push(`${repo.provider}:${repo.repoPath}`);
    }
  }

  return batchesResult(
    results,
    failures,
    groupStatuses,
    dirtied,
    setupFailedRepositories,
    ranChecks,
    selection,
  );
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
  config: RepoScriptsConfig,
): RepoScriptsConfig["repositories"] {
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
  groupStatuses: RepoScriptsGroupStatusEntry[],
  dirtied: RepoScriptsDirtiedRepo[],
  /** Repositories earlier in this same pass whose setup failed. Carried so a
   *  stall cannot quietly report setupFailed: false next to a summary that
   *  says SETUP FAILED. */
  setupFailedRepositories: string[],
): CheckBatchesResult {
  const stallFailure: PrePrCheckFailure = {
    provider,
    repoPath,
    command: collected.progress.stoppedAt ?? "(pre-PR check batch)",
    exitCode: -1,
    stdout: "",
    stderr: batchStallReason(stall, elapsedMs, collected.progress),
    // The batch never reported, so this is not a check result at all. Without a
    // phase it reads as an ordinary failing check, and every sentence that only
    // makes sense for a command that ran would be attached to it.
    phase: "batch",
  };
  const allResults = [...results, ...collected.results];
  const allFailures = [...failures, ...collected.failures, stallFailure];
  return {
    outcome: "failed",
    passed: false,
    results: allResults,
    failures: allFailures,
    groupStatuses,
    dirtied,
    setupFailed: setupFailedRepositories.length > 0,
    summary: formatPrePrCheckFailures(allFailures),
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
