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
  remainingChecksMs,
  type RunBudgetObservation,
} from "../run-budget.js";
import {
  PHASE_POLL_TICK_MAX_MS,
  pollPhaseUntilDone,
  type PhasePollOutcome,
  type PhasePollTuning,
} from "./poll-phase.js";
import type { StepsRecord } from "../../workflow-definition/interpreter.js";

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
  /**
   * The same observer, charging what it measures to the checks ceiling instead
   * of to the run's duration.
   *
   * Two observers rather than one flag, because the split is a boundary and not
   * a mode: `observeBudget` closes the run's clock at the launch, and this one
   * carries every tick the poll then waits through. A caller that supplies only
   * the first keeps the old behaviour, which is what run_checks' explicit
   * command mode does when nothing prepared a workspace.
   */
  observeChecksBudget?: (
    requireRemainingDuration?: boolean,
  ) => Promise<RunBudgetObservation>;
  cancellation?: V2InvocationCancellation;
  /**
   * The checks ceiling, in milliseconds, as prepare_workspace published it.
   *
   * Absent on a run whose workspace was prepared by a deployment that did not
   * publish one, and then the ceiling is derived from the configuration here
   * instead. Preferring the published number when it exists is not a detail:
   * it is what the sandbox's lifetime was sized for, so a configuration whose
   * batchTimeoutMinutes was raised mid-run cannot hand a batch a bound its
   * sandbox will not survive.
   */
  checksCeilingMs?: number;
  /** @deprecated Only the repair agent spent tokens from this path. */
  budget?: PrePrFixBudgetContext;
  /** @deprecated As budget. */
  runtime?: ResolvedHarnessRuntime;
  /** @deprecated As budget. */
  arthurTaskId?: string | null;
}

/**
 * Ticks to authorize for a poll bounded by `capMs`.
 *
 * Derived rather than fixed. A fixed 200 ticks covers about 98 minutes at the
 * 30s ceiling, so a configuration asking for 180 minutes was silently
 * impossible: the tick cap ended the poll first and the run reported "the
 * checks ran for 1h38m without finishing", blaming the batch for a bound
 * nobody could see. The derived cap always matches the time bound the operator
 * actually configured.
 *
 * The margin covers the ramp. The first ticks are 2s and grow by 1.6 toward
 * the 30s ceiling, so roughly seven of them pass before a tick is worth a full
 * ceiling; eight is that with a tick to spare.
 *
 * The tradeoff it prices: every tick is a journaled step record. At the
 * schema's 180 minute maximum this authorizes about 368 of them in one run, on
 * a code path that has lost runs to CORRUPTED_EVENT_LOG. That is the reason
 * the schema has a maximum at all, and the reason to raise the ceiling only
 * for a batch that genuinely needs it.
 */
export function maxTicksFor(capMs: number): number {
  const bounded = Number.isFinite(capMs) && capMs > 0 ? capMs : 0;
  return Math.ceil(bounded / PHASE_POLL_TICK_MAX_MS) + 8;
}

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
export function batchPollTuning(
  outcome: PhasePollOutcome,
  capMs: number,
  phase: RepoBatchPhase = "checks",
): PhasePollTuning {
  return {
    checkBeforeFirstTick: true,
    // Checks time is charged to the checks ceiling, and that ceiling is
    // already the phase cap, so consulting the run's duration would halt the
    // run as budget_exceeded instead of reporting checks that outlived their
    // bound. Setup is the opposite case: it is provisioning, its time IS the
    // run's, and a run that dies during `uv sync` genuinely ran out of time.
    ignoreRemainingDuration: phase !== "setup",
    initialTickMs: 2_000,
    tickGrowthFactor: 1.6,
    maxTicks: maxTicksFor(capMs),
    stoppedObservations: 2,
    outcome,
  };
}

/**
 * The time bound that actually applies to one batch, in milliseconds, and the
 * gate that refuses to start one at all.
 *
 * What bounds a batch is the checks phase's own ceiling, minus the checks time
 * this run has already spent. The run's remaining duration budget is no longer
 * in it: a test suite is not agent work, and charging nineteen minutes of
 * pytest against the same budget that pays for the agent made a green check
 * run the reason a run halted as budget_exceeded.
 *
 * That also removes the margin this function used to add. The margin existed
 * because the phase cap and the duration budget were two clocks racing, and
 * whichever fired first decided how the run ended; now the phase cap IS the
 * checks bound, so nothing has to be overshot for it to win.
 *
 * The observation is taken with the default attribution on purpose. It runs
 * immediately before the launch, so everything up to it is the run's time and
 * everything the poll then waits for is the checks phase's.
 *
 * It also throws on an exhausted token or cost budget, before anything is
 * launched. The poll would raise the same error on its first tick, but only
 * after a wrapper had been written, chmodded and started in the sandbox.
 */
export async function batchCapMs(
  observeBudget: PrePrChecksOptions["observeBudget"],
  ceilingMs: number,
  phase: RepoBatchPhase = "checks",
): Promise<number> {
  const observed = await observeBudget(false);
  if (observed.check.status !== "ok") throw new RunBudgetError(observed.check);
  // Setup spends the run's duration, not the checks ceiling, so the ceiling is
  // only a backstop against an unbounded poll here. The bound that actually
  // binds is the remaining duration, which the poll re-reads on every tick.
  return phase === "setup" ? ceilingMs : remainingChecksMs(observed, ceilingMs);
}

/**
 * Which budget a batch is spending.
 *
 * "setup" is provisioning a workspace (a toolchain install, a registry login):
 * it is the run's own time, bounded by the run's duration budget. "checks" is
 * verification, charged to the checks ceiling and deliberately outside the
 * duration budget. The distinction decides three things at once: which clock
 * the elapsed time lands on, which bound the poll obeys, and which knob an
 * operator is told to turn when it runs out.
 */
export type RepoBatchPhase = "checks" | "setup";

/**
 * The checks ceiling in milliseconds, from the configuration's own
 * batchTimeoutMinutes when it sets one and the operator ceiling otherwise.
 *
 * The configuration wins by design: an operator who raises batchTimeoutMinutes
 * has said what their batch really costs. It is a whole-run ceiling and not a
 * per-batch one, so four repositories share it rather than getting four.
 */
export function checksCeilingMsOf(batchTimeoutMinutes?: number): number {
  const minutes =
    typeof batchTimeoutMinutes === "number" && Number.isFinite(batchTimeoutMinutes) &&
    batchTimeoutMinutes > 0
      ? batchTimeoutMinutes
      : PRE_PR_CHECK_BATCH_MAX_MINUTES;
  return minutes * 60_000;
}

/**
 * What workspace creation needs to know about the checks phase: how long it may
 * run, and which setup commands to provision with.
 *
 * One step for both, because they come from the same row and must agree. It is
 * journaled, so the sandbox's lifetime and the bound the poll later applies are
 * the same number even across a resume; re-deriving the ceiling from a
 * configuration edited in between would hand a batch a bound its sandbox will
 * not survive.
 *
 * It never fails the caller, and returns a null config rather than throwing.
 * A configuration the schema cannot read is a real and loud failure, but it
 * belongs to the checks block, which names the field that broke. Failing
 * workspace creation for it would stop a run that has not reached a check yet,
 * and would stop runs whose graph never runs one. The same holds for the store
 * being unreachable: provisioning is not the place to discover it.
 */
export async function resolveChecksProvisioningStep(): Promise<{
  ceilingMs: number;
  config: unknown | null;
}> {
  "use step";
  const fallback = PRE_PR_CHECK_BATCH_MAX_MINUTES * 60_000;
  try {
    const { getDb } = await import("../../db/client.js");
    const { getCurrentPrePrCheckConfig } = await import("../../pre-pr-checks/store.js");
    const { repoScriptsConfigSchema } = await import("../../pre-pr-checks/config.js");
    const current = await getCurrentPrePrCheckConfig(getDb());
    if (!current) return { ceilingMs: fallback, config: null };
    const parsed = repoScriptsConfigSchema.safeParse(current.config);
    return {
      ceilingMs: parsed.success
        ? checksCeilingMsOf(parsed.data.batchTimeoutMinutes)
        : fallback,
      config: current.config,
    };
  } catch {
    return { ceilingMs: fallback, config: null };
  }
}
resolveChecksProvisioningStep.maxRetries = 0;

/**
 * Recover the checks ceiling a run agreed on from its prepare_workspace output.
 *
 * Absent-tolerant by contract. A run prepared by a deployment that published no
 * ceiling, and a graph with no prepare_workspace at all, both return null, and
 * the caller falls back to deriving one. Returning a wrong number here would be
 * worse than returning none: it is the number the sandbox's lifetime was sized
 * against.
 */
export function recoverChecksCeilingFromSteps(steps: StepsRecord): number | null {
  const outputs = Object.values(steps);
  for (let index = outputs.length - 1; index >= 0; index -= 1) {
    const value = (outputs[index]?.output as Record<string, unknown> | undefined)
      ?.checksCeilingMs;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return null;
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

/** What provisioning learned from running the configured setup commands. */
export interface RepositorySetupOutcome {
  /** Repositories whose setup was actually launched in this workspace. */
  ran: number;
  /** Setup commands that failed, and batches that never reported one way or
   *  the other. Empty means every launched setup finished clean. */
  failures: PrePrCheckFailure[];
  /** One sentence for a human, whichever way it went. */
  summary: string;
}

/**
 * Run every configured repository's `setup` commands, once, at workspace
 * creation.
 *
 * Setup provisions a toolchain the sandbox image does not ship (`uv`, a private
 * registry login, a language runtime). It used to run inside the first check
 * batch, which put a five minute `uv sync` inside the bound meant for the tests
 * and made the first check of a run mysteriously slower than the rest. Running
 * it here makes it a visible substep of workspace creation: its launch, its
 * poll and its collect are the run's own steps, and a failing setup command
 * fails provisioning loudly instead of surfacing as a check that timed out.
 *
 * Later batches do not repeat the work. The wrapper writes a marker keyed on a
 * hash of the setup array (setupMarkerPath), so a batch carrying the same setup
 * finds the marker and skips straight to its commands.
 *
 * Its time is the RUN's, not the checks phase's. Setup is provisioning, and
 * three repositories running `uv sync` must not eat the budget the tests were
 * given; an operator whose run dies inside it has to be pointed at the setup
 * commands, never at batchTimeoutMinutes. So it takes no checks observer and
 * runs with phase "setup", which keeps the run's remaining duration binding
 * the poll tick by tick, exactly as every other block is bound.
 *
 * It never fails on a configuration it cannot read. That failure belongs to the
 * checks block, which names the field that broke; refusing to create a
 * workspace for it would also stop every run whose graph runs no checks at all.
 */
export async function runRepositorySetup(options: {
  sandboxId: string;
  config: unknown;
  observeBudget: PrePrChecksOptions["observeBudget"];
  /** Only a backstop on the poll here, never a budget setup draws from. */
  checksCeilingMs?: number;
  cancellation?: V2InvocationCancellation;
}): Promise<RepositorySetupOutcome> {
  const { repoScriptsConfigSchema } = await import("../../pre-pr-checks/config.js");
  const parsed = repoScriptsConfigSchema.safeParse(options.config);
  if (!parsed.success) {
    return {
      ran: 0,
      failures: [],
      summary:
        options.config === null
          ? "No repository scripts configuration is stored, so no setup ran."
          : "The repository scripts configuration could not be read, so no setup ran. " +
            "The workspace is ready; the checks block will report the broken field.",
    };
  }

  const failures: PrePrCheckFailure[] = [];
  let ran = 0;
  for (const [repoIndex, repo] of uniqueConfiguredRepositories(parsed.data).entries()) {
    const setup = repo.setup ?? [];
    if (setup.length === 0) continue;
    const run = await runRepoCheckBatch({
      sandboxId: options.sandboxId,
      provider: repo.provider,
      repoPath: repo.repoPath,
      setup,
      // Setup only. A repository configured but absent from this workspace is
      // skipped by the launch step, so the intersection needs no second pass.
      commands: [],
      fixCycle: 0,
      repoIndex,
      // Provisioning is not conditional on the agent having touched anything:
      // there is no agent work yet at this point in the run.
      requireChange: false,
      observeBudget: options.observeBudget,
      phase: "setup",
      ...(options.checksCeilingMs === undefined
        ? {}
        : { checksCeilingMs: options.checksCeilingMs }),
      ...(options.cancellation ? { cancellation: options.cancellation } : {}),
      ...(repo.env && repo.env.length > 0 ? { envNames: repo.env } : {}),
      ...(repo.commandTimeoutMinutes === undefined
        ? {}
        : { commandTimeoutMinutes: repo.commandTimeoutMinutes }),
    });
    if (run.skipped) continue;
    ran += 1;
    if (run.stall) {
      failures.push({
        provider: repo.provider,
        repoPath: repo.repoPath,
        command: setup.join(" && "),
        exitCode: -1,
        stdout: "",
        stderr: "",
        note:
          `Setup for ${repo.repoPath} ${
            run.stall === "sandbox_stopped"
              ? "lost its sandbox"
              : `did not finish within ${formatElapsed(run.elapsedMs)}`
          }, so the workspace is not provisioned.`,
        phase: "setup",
      });
    }
    failures.push(...run.collected.failures);
  }

  return {
    ran,
    failures,
    summary:
      failures.length > 0
        ? `Setup failed in ${failures.length} of ${ran} repositories.`
        : ran === 0
          ? "No repository configured setup commands."
          : `Setup completed in ${ran} ${ran === 1 ? "repository" : "repositories"}.`,
  };
}

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

/**
 * The one failure a run gets when its checks ceiling runs out mid-walk.
 *
 * A failure and not a skip: nothing verified these repositories, and a gate
 * that treated "no time left" as "nothing to do" would pass a publication no
 * check ever looked at. One entry rather than one per repository, because the
 * exhausted budget is a fact about the run; the repositories it cost are the
 * detail, and they are named in the note.
 */
function checksBudgetExhaustedFailure(
  skipped: Array<{ provider: PrePrCheckFailure["provider"]; repoPath: string }>,
  ceilingMs: number,
): PrePrCheckFailure {
  const minutes = Math.round(ceilingMs / 60_000);
  const names = skipped.map((repo) => `${repo.provider}:${repo.repoPath}`);
  const first = skipped[0];
  return {
    // Attributed to the first repository it cost, which is the one whose turn
    // came when the budget ran out.
    provider: first?.provider ?? "github",
    repoPath: first?.repoPath ?? "",
    command: "(checks budget)",
    exitCode: -1,
    stdout: "",
    stderr: "",
    note:
      `Nothing ran in ${names.length} ${names.length === 1 ? "repository" : "repositories"} ` +
      `(${names.join(", ")}): this run's ${minutes} minute checks budget was already ` +
      "spent by the repositories before them. Raise batchTimeoutMinutes in the " +
      "repository scripts configuration, or split the run.",
    phase: "budget",
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
  /**
   * The run's checks ceiling was already spent, so nothing was launched.
   *
   * A flag rather than a failure entry, because the failure belongs to the RUN
   * and not to this repository: the caller stops the walk and writes one
   * paragraph naming every repository it did not reach. Eight repositories
   * each reporting the same exhausted budget is eight identical paragraphs in
   * a ticket comment nobody reads to the end.
   */
  budgetExhausted?: boolean;
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
  /** The run's checks ceiling in milliseconds. What is left of it after the
   *  batches already run is this batch's bound. */
  checksCeilingMs?: number;
  /** The observer to hand the poll, already charging its time to the checks
   *  ceiling. Absent for callers with no attribution seam, which then spend the
   *  run's duration as before. */
  observeChecksBudget?: PrePrChecksOptions["observeBudget"];
  /** Which budget this batch spends. Default "checks". */
  phase?: RepoBatchPhase;
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
  const phase = args.phase ?? "checks";
  const ceilingMs = args.checksCeilingMs ?? checksCeilingMsOf();
  const capMs = await batchCapMs(args.observeBudget, ceilingMs, phase);
  if (capMs <= 0) {
    // Nothing is launched, and nothing is claimed about this repository. A
    // batch given no time would be collected as a batch that reported nothing,
    // which reads as an infrastructure fault; the truth is that earlier
    // repositories spent the run's ceiling. The caller turns this into one
    // failure for the whole slice it could not reach.
    return {
      skipped: false,
      collected: {
        results: [],
        failures: [],
        setupFailed: false,
        dirtied: [],
        preExistingDirty: [],
        setupMarkerFailed: false,
        progress: { completed: 0, total, stoppedAt: null },
      },
      stall: null,
      elapsedMs: 0,
      budgetExhausted: true,
    };
  }
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
      // Unused: phaseLimitMs below replaces it, and the bound is the remaining
      // checks ceiling in milliseconds rather than a whole number of minutes.
      0,
      started.commandId,
      // Setup deliberately keeps the plain observer: its waiting is the run's
      // time, so it must land on the duration clock like every other block.
      phase === "setup"
        ? args.observeBudget
        : args.observeChecksBudget ?? args.observeBudget,
      args.cancellation,
      { ...batchPollTuning(outcome, capMs, phase), phaseLimitMs: capMs },
    );
  } catch (error) {
    // A budget stop still ends the run, but the wrapper's files say exactly how
    // far the checks got and the operator has no other way to find out.
    throw await budgetErrorNamingProgress(
      error,
      args.provider,
      args.repoPath,
      collect,
      phase,
    );
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
/**
 * A batch that ran nothing, as distinct from a repository this run never
 * selected.
 *
 * The distinction is the whole point. groupStatusesFor reads a NULL collect as
 * "skipped", which means "not part of this run"; it reads an empty collect as
 * "not_run", because the group was selected, nothing ran, and nothing may be
 * claimed about it. Handing the budget-exhausted slice a null collect would
 * mark selected groups skipped, which is the false-pass shape: skipped groups
 * do not hold allPassed down.
 */
function unrunBatch(): CollectedRepoCheckBatch {
  return unreadableBatch();
}

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
  const ceilingMs = options.checksCeilingMs ?? checksCeilingMsOf(config.batchTimeoutMinutes);
  let ranChecks = 0;

  const configuredRepositories = uniqueConfiguredRepositories(config);
  for (const [repoIndex, repo] of configuredRepositories.entries()) {
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
      ...(options.observeChecksBudget
        ? { observeChecksBudget: options.observeChecksBudget }
        : {}),
      checksCeilingMs: ceilingMs,
      cancellation: options.cancellation,
      ...(repo.env && repo.env.length > 0 ? { envNames: repo.env } : {}),
      ...(repo.commandTimeoutMinutes === undefined
        ? {}
        : { commandTimeoutMinutes: repo.commandTimeoutMinutes }),
    });
    if (run.budgetExhausted) {
      // Stop launching, never stop accounting. Every repository from here on
      // gets its group statuses from a null collect, so its selected groups
      // land not_run: allPassed goes false, anyFailed goes true, and the gate
      // cannot read an exhausted budget as a pass. Only the launches stop.
      const unreached = configuredRepositories.slice(repoIndex);
      for (const pending of unreached) {
        const pendingPlan = await planRepository(pending, selection);
        groupStatuses.push(
          ...groupStatusesFor(
            pending,
            pendingPlan.selectedGroups,
            pendingPlan.groupCommands,
            // An empty collect, never null: these groups WERE selected and did
            // not run, so they are not_run rather than skipped.
            unrunBatch(),
          ),
        );
      }
      failures.push(checksBudgetExhaustedFailure(unreached, ceilingMs));
      break;
    }
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
  /** Named in the reason, because the two phases spend different budgets and
   *  an operator reading "setup stopped" reaches for a different knob than one
   *  reading "checks stopped". */
  phase: RepoBatchPhase = "checks",
): Promise<unknown> {
  if (!isRunBudgetError(error)) return error;
  // Guarded for the same reason the stall path is: this reads a sandbox the run
  // is already leaving, and a throw here would replace the budget stop with an
  // unclassified failure, which is worse than a budget stop with no detail.
  const collected = await collectAbandonedBatch(collect);
  return new RunBudgetError({
    ...error.failure,
    reason:
      `${error.failure.reason}; ${phase} for ${provider}:${repoPath} stopped` +
      `${formatProgress(collected.progress)}`,
  });
}
