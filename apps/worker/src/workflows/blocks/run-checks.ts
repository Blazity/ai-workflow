import { z } from "zod";
import {
  boundFailureOutput,
  listWorkspaceRepositoriesStep,
  type CheckOutcome,
  type CollectedRepoCheckBatch,
  type PrePrCheckFailure,
} from "../../pre-pr-checks/runner.js";
import {
  RunBudgetError,
  durationBudgetFailure,
  isDurationAbortError,
} from "../run-budget.js";
import { isRunControlError } from "../run-control-error.js";
import {
  invalidateWorkspaceGate,
  recordSuccessfulWorkspaceGate,
} from "../workspace-gate.js";
import {
  batchStallReason,
  loadPrePrCheckConfigStep,
  runPrePrChecksWithFixes,
  runRepoCheckBatch,
  type PrePrChecksOptions,
} from "./pre-pr-checks.js";
import {
  blockBudgetObserver,
  executionError,
  type BlockExecuteFn,
  type BlockExecutionResult,
} from "./types.js";

export const paramsSchema = z
  .object({
    commands: z.array(z.string().trim().min(1)).optional(),
    skipReason: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.skipReason && (value.commands?.length ?? 0) > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["skipReason"],
        message: "Skip reason cannot be combined with commands.",
      });
    }
  });

/** Per-failure output the block reports. Kept at the historical size: it is a
 *  block output field, read in the dashboard and fed to later prompts. */
const OUTPUT_TRUNCATE = 2000;

interface RunChecksStepResult {
  outcome: Exclude<CheckOutcome, "skipped" | "missing_configuration">;
  results: Array<{ repo: string; command: string; exitCode: number }>;
  failures: Array<{ repo: string; command: string; exitCode: number; output: string }>;
}

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
  cancellation: PrePrChecksOptions["cancellation"],
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
      cancellation,
    });
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
              batchStallReason(run.stall, run.elapsedMs, run.collected.progress),
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
  cancellation: PrePrChecksOptions["cancellation"],
): Promise<
  Omit<RunChecksStepResult, "outcome"> & {
    outcome: Exclude<CheckOutcome, "skipped">;
    configurationVersion: number | null;
    summary: string;
  }
> {
  const current = await loadPrePrCheckConfigStep();
  const run = await runPrePrChecksWithFixes({
    sandboxId,
    config: current.config,
    agentKind,
    model,
    maxFixCycles: 0,
    observeBudget,
    cancellation,
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
    results,
    failures,
    summary: run.summary,
  };
}

/**
 * run_checks: report-only check runner. With a commands param it runs each
 * command in every workspace repository; without it it runs the dashboard's
 * pre-PR-checks config once (no fix cycles). Failing checks are a normal
 * branchable outcome: the block returns kind "next" with { status: "ok",
 * ok: false } when checks ran and failed, reserving kind "execution_error" for
 * infrastructure errors (checks could not run at all).
 */
export const execute: BlockExecuteFn = async (
  block,
  _steps,
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
  const budget = await ctx.observeBudget();
  if (budget.check.status !== "ok") throw new RunBudgetError(budget.check);

  try {
    const result =
      commands.length > 0
        ? await runExplicitCommands(
            ctx.sandboxId,
            commands,
            blockBudgetObserver(ctx, execution),
            execution?.cancellation,
          )
        : await runConfiguredChecks(
            ctx.sandboxId,
            ctx.runDefaultKind,
            ctx.defaults[ctx.runDefaultKind],
            blockBudgetObserver(ctx, execution),
            execution?.cancellation,
          );
    if (
      "configurationVersion" in result &&
      result.outcome === "passed" &&
      result.configurationVersion !== null &&
      ctx.workspaceManifest
    ) {
      ctx.prePrGate = await recordSuccessfulWorkspaceGate({
        sandboxId: ctx.sandboxId,
        workspaceManifest: ctx.workspaceManifest,
        configurationVersion: result.configurationVersion,
      });
    }
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
        // Durably checkpoint the gate just recorded to ctx.prePrGate so finalize
        // can recover it on a cold scheduler resume. Spread into a plain JSON
        // object for the BlockOutput contract. Null when no gate was recorded
        // (commands path, failed/missing config, or no workspace manifest).
        gate: ctx.prePrGate
          ? {
              configurationVersion: ctx.prePrGate.configurationVersion,
              fingerprint: ctx.prePrGate.fingerprint,
            }
          : null,
      },
    };
  } catch (err) {
    if (isRunControlError(err)) throw err;
    const after = await ctx.observeBudget();
    if (after.check.status !== "ok") throw new RunBudgetError(after.check);
    if (isDurationAbortError(err)) {
      throw new RunBudgetError(durationBudgetFailure(after, "Run checks"));
    }
    return executionError(err instanceof Error ? err.message : String(err), {
      category: "checks",
    });
  }
};
