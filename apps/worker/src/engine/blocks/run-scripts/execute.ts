import type {
  BlockExecutionResult,
  BlockExecuteFn,
} from "../support/types.js";
import { blockBudgetObserver, executionError } from "../support/types.js";
import {
  loadPrePrCheckConfigStep,
  runChecksScopeKeys,
  recoverChecksCeilingFromSteps,
  runPrePrChecksWithFixes,
} from "../pre-pr-checks.js";
import {
  repositoryScriptsOutput,
  repositoryScriptsStatus,
} from "../support/repository-scripts-output.js";
import type { PrePrCheckRunResult } from "../../steps/pre-pr-checks-runner.js";
import {
  RunBudgetError,
  isChecksCeilingExceededError,
  propagateInvocationInterruption,
  type RunBudgetAttribution,
  type RunBudgetObservation,
} from "../../helpers/run-budget.js";
import { isRunControlError } from "../../helpers/run-control-error.js";

type BoundaryCapableBudgetObserver = (
  requireRemainingDuration?: boolean,
  attribution?: RunBudgetAttribution,
  observedAtMs?: number,
) => Promise<RunBudgetObservation>;

function checksBudgetObserver(
  ctx: Parameters<BlockExecuteFn>[2],
  execution?: Parameters<BlockExecuteFn>[4],
): (
  requireRemainingDuration?: boolean,
  observedAtMs?: number,
) => Promise<RunBudgetObservation> {
  const observe = (execution?.budget.observeBudget ??
    ctx.observeBudget) as BoundaryCapableBudgetObserver;
  return (requireRemainingDuration, observedAtMs) =>
    observe(requireRemainingDuration, "checks", observedAtMs);
}

function checksCeilingOption(
  steps: Parameters<BlockExecuteFn>[1],
): { checksCeilingMs?: number } {
  const ceilingMs = recoverChecksCeilingFromSteps(steps);
  return ceilingMs === null ? {} : { checksCeilingMs: ceilingMs };
}

export const execute: BlockExecuteFn = async (
  block,
  steps,
  ctx,
  _resolvedInputs,
  execution,
): Promise<BlockExecutionResult> => {
  if (!ctx.sandboxId) {
    return executionError(
      "no workspace: connect prepare_workspace before run_scripts",
      { category: "sandbox" },
    );
  }
  const groups = Array.isArray(block.params.groups)
    ? block.params.groups.filter((group): group is string => typeof group === "string")
    : [];
  const budget = await ctx.observeBudget();
  if (budget.check.status !== "ok") throw new RunBudgetError(budget.check);
  const current = await loadPrePrCheckConfigStep(runChecksScopeKeys(ctx));
  let run: PrePrCheckRunResult;
  try {
    run = await runPrePrChecksWithFixes({
      sandboxId: ctx.sandboxId,
      config: current.config,
      agentKind: ctx.runDefaultKind,
      model: ctx.defaults[ctx.runDefaultKind],
      groupSelection: { kind: "named", groups },
      defaultCommandTimeoutMinutes: ctx.settings.PRE_PR_COMMAND_TIMEOUT_MINUTES,
      observeBudget: blockBudgetObserver(ctx, execution),
      observeChecksBudget: checksBudgetObserver(ctx, execution),
      ...checksCeilingOption(steps),
      cancellation: execution?.cancellation,
      ...(execution?.observations ? { observations: execution.observations } : {}),
    });
  } catch (err) {
    if (isRunControlError(err) || isChecksCeilingExceededError(err)) throw err;
    propagateInvocationInterruption(err);
    const after = await ctx.observeBudget(false, "checks");
    if (after.check.status !== "ok") throw new RunBudgetError(after.check);
    throw new Error(await ctx.prePrChecksFailureMessage(err, current.version), { cause: err });
  }
  const output = repositoryScriptsOutput(run, groups);
  return {
    kind: "next",
    output: { status: repositoryScriptsStatus(output), ...output },
  };
};
