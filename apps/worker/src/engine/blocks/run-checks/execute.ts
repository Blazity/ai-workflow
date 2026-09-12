import {
  boundFailureOutput,
  listWorkspaceRepositoriesStep,
  type CheckOutcome,
  type CollectedRepoCheckBatch,
  type PrePrCheckFailure,
} from "../../steps/pre-pr-checks-runner.js";
// The mapped alias, not the engine's interface: a block output field has to
// satisfy BlockOutput's JsonValue index signature, which TypeScript grants to
// object type aliases only.
import {
  countUncoveredGroups,
  type RepositoryScriptGroupCoverage,
} from "../support/repository-scripts-output.js";
import {
  checksCeilingErrorDetail,
  isChecksCeilingExceededError,
  RunBudgetError,
  propagateInvocationInterruption,
  type RunBudgetAttribution,
  type RunBudgetObservation,
} from "../../helpers/run-budget.js";
import { isRunControlError } from "../../helpers/run-control-error.js";
import {
  invalidateWorkspaceGate,
  recordSuccessfulWorkspaceGate,
  serializeWorkspaceGate,
} from "../../steps/workspace-gate.js";
import {
  batchStallReason,
  checksBudgetExhaustedFailure,
  checksCeilingMsOf,
  loadPrePrCheckConfigStep,
  runChecksScopeKeys,
  runPrePrChecksWithFixes,
  recoverChecksCeilingFromSteps,
  runRepoCheckBatch,
  type PrePrChecksOptions,
} from "../pre-pr-checks.js";
import {
  blockBudgetObserver,
  executionError,
  type BlockExecuteFn,
  type BlockExecutionResult,
} from "../support/types.js";

/**
 * A repository script group name, as a block selects it.
 *
 * Built from the shared constants in `@shared/contracts`, which own the shape:
 * a node references group names that screen authored, and the dashboard blocks
 * a Save against the same three values, so a name accepted on one side and
 * refused on another could never match anything at run time. Exported because
 * the v2 configuration schema for run_scripts selects the same names.
 */
/** Per-failure output the block reports. Kept at the historical size: it is a
 *  block output field, read in the dashboard and fed to later prompts. */
const OUTPUT_TRUNCATE = 2000;

interface RunChecksStepResult {
  outcome: Exclude<CheckOutcome, "skipped" | "missing_configuration">;
  results: Array<{ repo: string; command: string; exitCode: number }>;
  failures: Array<{ repo: string; command: string; exitCode: number; output: string }>;
}

/** Coverage of the explicit-commands mode: none, and not an omission. That mode
 *  authors no groups at all, so there is no selection to be partly covered.
 *  The same is true of the default gating selection, which the engine reports
 *  as no coverage for its own reasons. */
const NO_GROUP_COVERAGE: RepositoryScriptGroupCoverage[] = [];

type BoundaryCapableBudgetObserver = (
  requireRemainingDuration?: boolean,
  attribution?: RunBudgetAttribution,
  observedAtMs?: number,
) => Promise<RunBudgetObservation>;


function toBlockResults(
  collected: CollectedRepoCheckBatch,
): RunChecksStepResult["results"] {
  return collected.results.map((result) => ({
    repo: `${result.provider}:${result.repoPath}`,
    command: result.command,
    exitCode: result.exitCode,
  }));
}

function toBlockFailures(
  collected: CollectedRepoCheckBatch,
): RunChecksStepResult["failures"] {
  return collected.failures.map(toBlockFailure);
}

function toBlockFailure(
  failure: PrePrCheckFailure,
): RunChecksStepResult["failures"][number] {
  return {
    repo: `${failure.provider}:${failure.repoPath}`,
    command: failure.command,
    exitCode: failure.exitCode,
    output: failureOutput(failure),
  };
}

/**
 * The command's own output, bounded, then the note on its own line.
 *
 * The note is appended AFTER the bound on purpose. This block's failure shape
 * has one `output` string and no field for a note, so folding the note into a
 * stream before bounding puts it at the join between stderr and stdout, which
 * is the middle a head-and-tail bound deletes: an operator would read
 * `exitCode: 0` under a heading that says failures with nothing saying why.
 */
function failureOutput(failure: PrePrCheckFailure): string {
  const output = boundFailureOutput(
    [failure.stderr, failure.stdout]
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n"),
    OUTPUT_TRUNCATE,
  );
  if (!failure.note) return output;
  return output ? `${output}\n${failure.note}` : failure.note;
}

/**
 * Explicit-commands checks: every authored command, in every workspace
 * repository, launched detached per repository and polled across ticks.
 *
 * Deliberately NOT a "use step", for the same reason the configured path is
 * not. This mode used to run its commands inline under an
 * `AbortSignal.timeout(remainingDurationMs)`, which reads like a bound but is
 * not one: that signal can only fire while the remaining budget happens to be
 * under the 300s a function invocation gets, and above that the invocation is
 * killed before the signal can reach it. So this was never the safe mode with
 * a timeout, it was the same defect wearing a timeout that cannot fire. The
 * real bound is the budget observer, which pollPhaseUntilDone re-reads on
 * every tick.
 */
async function runExplicitCommands(
  sandboxId: string,
  commands: string[],
  observeBudget: PrePrChecksOptions["observeBudget"],
  observeChecksBudget: NonNullable<PrePrChecksOptions["observeChecksBudget"]>,
  cancellation: PrePrChecksOptions["cancellation"],
  checksCeilingMs: number | null,
): Promise<RunChecksStepResult> {
  const repositories = await listWorkspaceRepositoriesStep(sandboxId);
  const results: RunChecksStepResult["results"] = [];
  const failures: RunChecksStepResult["failures"] = [];

  for (const [repoIndex, repo] of repositories.entries()) {
    const run = await runRepoCheckBatch({
      sandboxId,
      provider: repo.provider,
      repoPath: repo.repoPath,
      // This mode authors no provisioning: the block takes one flat command
      // list and nothing else, so its batches always carry an empty setup
      // phase and the collector's setupFailed has nothing that can raise it.
      setup: [],
      commands,
      fixCycle: 0,
      repoIndex,
      // Every attached repository runs, changed or not. That is this mode's
      // contract, and it never inspected HEAD before.
      requireChange: false,
      observeBudget,
      observeChecksBudget,
      ...(checksCeilingMs === null ? {} : { checksCeilingMs }),
      cancellation,
    });
    if (run.budgetExhausted) {
      // The checks ceiling ran out before this repository's turn. Reporting the
      // repositories that DID finish as a pass would be the loudest possible
      // lie: the block's whole job is verification, and everything from here on
      // verified nothing. The group path already refuses this; the explicit
      // path did not look at the flag at all and returned outcome "passed" with
      // zero results.
      const unreached = repositories.slice(repoIndex);
      return {
        outcome: "failed",
        results: [...results, ...toBlockResults(run.collected)],
        failures: [
          ...failures,
          ...toBlockFailures(run.collected),
          toBlockFailure(
            checksBudgetExhaustedFailure(unreached, checksCeilingMs ?? checksCeilingMsOf()),
          ),
        ],
      };
    }
    if (run.skipped) continue;

    if (run.stall) {
      // A batch that outlived its bound or lost its sandbox verified nothing,
      // so it fails the block rather than reporting the commands that had
      // already finished as a pass. The walk stops with it: every later
      // repository's result would be meaningless anyway.
      return {
        outcome: "failed",
        results: [...results, ...toBlockResults(run.collected)],
        failures: [
          ...failures,
          ...toBlockFailures(run.collected),
          {
            repo: `${repo.provider}:${repo.repoPath}`,
            command: run.collected.progress.stoppedAt ?? "(check batch)",
            exitCode: -1,
            output: boundFailureOutput(
              batchStallReason(run.stall, run.collected.progress, {
                phase: "checks",
                provider: repo.provider,
                repoPath: repo.repoPath,
                ceilingMs: checksCeilingMs ?? checksCeilingMsOf(),
              }),
              OUTPUT_TRUNCATE,
            ),
          },
        ],
      };
    }

    // run.collected.setupFailed cannot be true here: it is raised only by an
    // authored setup command, of which this mode has none. A workspace that
    // could not be entered arrives as an ordinary failing entry, which is all
    // this block can carry anyway: its output contract has no phase field.
    results.push(...toBlockResults(run.collected));
    failures.push(...toBlockFailures(run.collected));
  }

  return {
    outcome: failures.length > 0 ? "failed" : "passed",
    results,
    failures,
  };
}

/**
 * Report-only configured checks.
 *
 * Deliberately NOT a "use step": the checks themselves are launched detached
 * and polled across ticks by runPrePrChecksWithFixes, because a real client
 * tenant's checks take far longer than the 300s a single function invocation
 * gets. Wrapping this in a step would put the whole poll back inside one
 * invocation and reinstate exactly the defect the poll exists to avoid.
 */
async function runConfiguredChecks(
  sandboxId: string,
  agentKind: PrePrChecksOptions["agentKind"],
  model: string,
  observeBudget: PrePrChecksOptions["observeBudget"],
  observeChecksBudget: NonNullable<PrePrChecksOptions["observeChecksBudget"]>,
  cancellation: PrePrChecksOptions["cancellation"],
  groups: string[],
  checksCeilingMs: number | null,
  /** The operator's PRE_PR_COMMAND_TIMEOUT_MINUTES, from the run's frozen
   *  settings. */
  defaultCommandTimeoutMinutes: number,
  /** The run's repository keys, so the composed ceiling is the highest claim
   *  among the repositories this run entered. */
  repositoryKeys: readonly string[] | undefined,
): Promise<
  Omit<RunChecksStepResult, "outcome"> & {
    outcome: Exclude<CheckOutcome, "skipped">;
    configurationVersion: number | null;
    /** The checks version of every configured repository at LAUNCH time, so
     *  the gate records what these checks ran under and not what somebody saved
     *  while they were running. */
    repositoryVersions: Record<string, number>;
    summary: string;
    groupCoverage: RepositoryScriptGroupCoverage[];
  }
> {
  const current = await loadPrePrCheckConfigStep(repositoryKeys);
  const run = await runPrePrChecksWithFixes({
    sandboxId,
    config: current.config,
    agentKind,
    model,
    defaultCommandTimeoutMinutes,
    observeBudget,
    observeChecksBudget,
    cancellation,
    ...(checksCeilingMs === null ? {} : { checksCeilingMs }),
    // No authored groups means the gate's own selection, which is what this
    // block ran before groups existed. Named groups make it a report-only
    // runner for any part of the configuration.
    ...(groups.length > 0
      ? { groupSelection: { kind: "named" as const, groups } }
      : {}),
  });
  const failures = run.failures.map(toBlockFailure);
  const results = (run.results ?? run.failures).map((result) => ({
    repo: `${result.provider}:${result.repoPath}`,
    command: result.command,
    exitCode: result.exitCode,
  }));
  const outcome =
    run.outcome ??
    (current.config.repositories.length === 0
      ? "missing_configuration"
      : run.passed
        ? "passed"
        : "failed");
  return {
    outcome,
    configurationVersion: current.version,
    repositoryVersions: current.repositoryVersions ?? {},
    results,
    failures,
    summary: run.summary,
    groupCoverage: run.groupCoverage,
  };
}

/**
 * run_checks: report-only check runner. With a commands param it runs each
 * command in every workspace repository; without it it runs the dashboard's
 * configured repository scripts once, either the groups the node names or, by
 * default, the groups the configuration marks as gating. Only the default
 * gating selection may record the publication gate; a named selection is
 * report-only in the strict sense and never touches ctx.prePrGate. Failing checks are a normal
 * branchable outcome: the block returns kind "next" with { status: "ok",
 * ok: false } when checks ran and failed, reserving kind "execution_error" for
 * infrastructure errors (checks could not run at all).
 */
export const execute: BlockExecuteFn = async (
  block,
  steps,
  ctx,
  _resolvedInputs,
  execution,
): Promise<BlockExecutionResult> => {
  const skipReason =
    typeof block.params.skipReason === "string" ? block.params.skipReason.trim() : "";
  if (skipReason) {
    return {
      kind: "next",
      output: {
        status: "ok",
        ok: true,
        outcome: "skipped",
        skipReason,
        results: [],
        failures: [],
        groupCoverage: NO_GROUP_COVERAGE,
        uncoveredGroupCount: 0,
      },
    };
  }
  if (!ctx.sandboxId) {
    return executionError(
      "no workspace: connect prepare_workspace before run_checks",
      { category: "sandbox" },
    );
  }
  invalidateWorkspaceGate(ctx);
  const commands = Array.isArray(block.params.commands)
    ? block.params.commands.filter((c): c is string => typeof c === "string")
    : [];
  const groups = Array.isArray(block.params.groups)
    ? block.params.groups.filter((g): g is string => typeof g === "string")
    : [];
  const budget = await ctx.observeBudget();
  if (budget.check.status !== "ok") throw new RunBudgetError(budget.check);

  // Two views of one budget context: the plain observer closes the run's clock
  // at each launch, the checks one carries every tick the poll waits through.
  const observeBudget = blockBudgetObserver(ctx, execution);
  const boundaryObserver = (execution?.budget.observeBudget ?? ctx.observeBudget) as
    BoundaryCapableBudgetObserver;
  const observeChecksBudget = (
    requireRemainingDuration?: boolean,
    observedAtMs?: number,
  ) => boundaryObserver(requireRemainingDuration, "checks", observedAtMs);
  const checksCeilingMs = recoverChecksCeilingFromSteps(steps);
  try {
    const result =
      commands.length > 0
        ? await runExplicitCommands(
            ctx.sandboxId,
            commands,
            observeBudget,
            observeChecksBudget,
            execution?.cancellation,
            checksCeilingMs,
          )
        : await runConfiguredChecks(
            ctx.sandboxId,
            ctx.runDefaultKind,
            ctx.defaults[ctx.runDefaultKind],
            observeBudget,
            observeChecksBudget,
            execution?.cancellation,
            groups,
            checksCeilingMs,
            ctx.settings.PRE_PR_COMMAND_TIMEOUT_MINUTES,
            runChecksScopeKeys(ctx),
          );
    if (
      "configurationVersion" in result &&
      // A named selection must never mint the publication gate. The gate means
      // "everything the configuration requires before a PR has passed", and a
      // node that ran only `lint` did not establish that. Worse, a group name
      // no repository declares runs zero commands and still reports passed, so
      // without this guard a typo would mint a green gate for a workspace
      // nothing verified. Absent groups keeps the historical behaviour: the
      // gating selection ran, so the gate is exactly what was established.
      groups.length === 0 &&
      result.outcome === "passed" &&
      result.configurationVersion !== null &&
      ctx.workspaceManifest
    ) {
      ctx.prePrGate = await recordSuccessfulWorkspaceGate({
        sandboxId: ctx.sandboxId,
        workspaceManifest: ctx.workspaceManifest,
        configurationVersion: result.configurationVersion,
        // Launch-time versions, carried out of the configuration load this run
        // already performed. Never re-read here: that would adopt an edit the
        // checks never executed.
        ...("repositoryVersions" in result
          ? { repositoryVersions: result.repositoryVersions }
          : {}),
      });
    }
    const coverage =
      "groupCoverage" in result ? result.groupCoverage : NO_GROUP_COVERAGE;
    return {
      kind: "next",
      output: {
        status: "ok",
        // Preserve the v1 Boolean contract: missing configuration was
        // historically a no-op, while the typed outcome makes it visible to v2.
        ok: result.outcome !== "failed",
        outcome: result.outcome,
        results: result.results,
        failures: result.failures,
        // Which repositories the named groups actually ran in. Empty for the
        // explicit-commands mode and for the default gating selection, neither
        // of which selects groups by name. This block reports a named selection
        // that ran zero commands as passed, and these two fields are what say
        // so out loud: branch on uncoveredGroupCount, which is a number the
        // branch language can compare.
        groupCoverage: coverage,
        uncoveredGroupCount: countUncoveredGroups(coverage),
        // Durably checkpoint the gate just recorded to ctx.prePrGate so finalize
        // can recover it on a cold scheduler resume. Spread into a plain JSON
        // object for the BlockOutput contract. Null when no gate was recorded
        // (commands path, failed/missing config, or no workspace manifest).
        gate: serializeWorkspaceGate(ctx.prePrGate),
      },
    };
  } catch (err) {
    if (isRunControlError(err)) throw err;
    if (isChecksCeilingExceededError(err)) {
      return executionError(checksCeilingErrorDetail(err), {
        category: "checks",
        message: err.message,
      });
    }
    propagateInvocationInterruption(err);
    const after = await observeChecksBudget(false);
    if (after.check.status !== "ok") throw new RunBudgetError(after.check);
    return executionError(err instanceof Error ? err.message : String(err), {
      category: "checks",
    });
  }
};
