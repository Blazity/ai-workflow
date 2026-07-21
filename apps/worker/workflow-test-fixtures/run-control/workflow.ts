import { getStepMetadata } from "workflow";
import { ActiveRunOwnerError } from "../../src/lib/run-control-errors.js";
import { isRunControlError } from "../../src/workflows/run-control-error.js";
import {
  RunBudgetError,
  runBudgetFailureFromError,
} from "../../src/workflows/run-budget.js";

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
