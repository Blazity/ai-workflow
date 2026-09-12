import { getStepMetadata } from "workflow";
// Worker source carries no ".js" suffix here: the Workflow builder's discovery
// resolves a relative specifier literally, and a suffix no file on disk carries
// drops this fixture's chain out of its import graph. See "A fixture reaches
// worker source without a file extension" in apps/worker/AGENTS.md.
import { ActiveRunOwnerError } from "../../src/services/run-lifecycle/run-control-errors";
import { isRunControlError } from "../../src/engine/helpers/run-control-error";
import { WorkflowExecutionError } from "../../src/engine/helpers/execution-error";
import {
  RunBudgetError,
  runBudgetFailureFromError,
} from "../../src/engine/helpers/run-budget";

type ProbeKind =
  | "owner_no_retries"
  | "owner_default_retries"
  | "budget_no_retries"
  | "ordinary_default_retries";

async function failOwnerWithoutRetries(): Promise<never> {
  "use step";
  throw new ActiveRunOwnerError(`attempt=${getStepMetadata().attempt}`);
}
failOwnerWithoutRetries.maxRetries = 0;

async function failOwnerWithDefaultRetries(): Promise<never> {
  "use step";
  throw new ActiveRunOwnerError(`attempt=${getStepMetadata().attempt}`);
}

async function failBudgetWithoutRetries(): Promise<never> {
  "use step";
  throw new RunBudgetError({
    status: "budget_exceeded",
    metric: "tokens",
    limit: 10,
    consumed: 11,
    reason: "budget exceeded",
  });
}
failBudgetWithoutRetries.maxRetries = 0;

async function failOrdinaryWithDefaultRetries(): Promise<never> {
  "use step";
  throw new Error(`ordinary failure attempt=${getStepMetadata().attempt}`);
}

async function failProviderWithoutRetries(): Promise<never> {
  "use step";
  throw new Error("provider secret detail");
}
failProviderWithoutRetries.maxRetries = 0;

async function deterministicCleanupStep(): Promise<void> {
  "use step";
}

export async function probeRunControlStepBoundary(kind: ProbeKind) {
  "use workflow";
  try {
    if (kind === "owner_no_retries") await failOwnerWithoutRetries();
    else if (kind === "owner_default_retries") await failOwnerWithDefaultRetries();
    else if (kind === "budget_no_retries") await failBudgetWithoutRetries();
    else await failOrdinaryWithDefaultRetries();
    throw new Error("expected the probe step to fail");
  } catch (error) {
    return {
      name:
        typeof error === "object" && error !== null && "name" in error
          ? String(error.name)
          : null,
      message:
        typeof error === "object" && error !== null && "message" in error
          ? String(error.message)
          : String(error),
      isRunControl: isRunControlError(error),
      budgetFailure: runBudgetFailureFromError(error),
      hasFailureProperty:
        typeof error === "object" && error !== null && "failure" in error,
    };
  }
}

export async function probeStickyExecutionFailure() {
  "use workflow";
  try {
    await failProviderWithoutRetries();
  } catch {
    await deterministicCleanupStep();
    throw new WorkflowExecutionError({
      category: "provider",
      message: "An external service could not complete this block.",
      diagnosticId: "AIW-DIAG-sdk-run-provider-1",
      nodeId: "provider",
      attempt: 1,
    });
  }
}
