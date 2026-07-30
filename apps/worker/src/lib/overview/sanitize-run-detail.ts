import type {
  RunDetail,
  RunError,
  RunStep,
} from "@shared/contracts";
import { EXECUTION_DIAGNOSTIC_PREFIX } from "@shared/contracts";

import { sanitizeReplayValue } from "../../run-observability/sanitizer.js";
import { configuredReplaySecrets } from "../../run-observability/configured-secrets.js";
import { sanitizeFailureMessage } from "../../workflow-definition/failure-message.js";

export function sanitizeRunError(
  error: string | RunError | null | undefined,
  fallback: string,
): RunError | null {
  if (!error) return null;
  const normalized = typeof error === "string" ? { message: error } : error;
  const sanitized = sanitizeReplayValue(normalized.message, {
    secrets: configuredReplaySecrets(),
  });
  // A whole composed message, not a bare detail: it already carries the generic
  // per-category text, the parenthesised cause snippet and the diagnostic ID, so
  // it gets the message-sized bound. Capping it at the snippet length here would
  // cut the cause snippet a second time and hand the browser a message that
  // stops mid-diagnosis.
  const message =
    !sanitized.metadata.unavailable && typeof sanitized.value === "string"
      ? sanitizeFailureMessage(sanitized.value)
      : "";
  const code = normalized.code?.startsWith(EXECUTION_DIAGNOSTIC_PREFIX)
    ? normalized.code
    : normalized.message.match(
        /Diagnostic ID: (AIW-DIAG-[A-Za-z0-9._:-]+)/,
      )?.[1];
  return {
    message: message || fallback,
    ...(code ? { code } : {}),
  };
}

export function sanitizeRunSteps(
  steps: RunStep[] | null,
  runError: RunError | null = null,
): RunStep[] | null {
  if (!steps) return null;
  const diagnosticRunError =
    runError?.code?.startsWith(EXECUTION_DIAGNOSTIC_PREFIX)
      ? sanitizeRunError(runError, "Workflow execution failed.")
      : null;
  return steps.map((step) => ({
    ...step,
    error: step.error
      ? diagnosticRunError ??
        sanitizeRunError(step.error, "Workflow step failed.")
      : null,
  }));
}

/**
 * Guarantee a terminal failed/blocked run always shows a cause. The specific
 * reason (execution error, budget stop, or who cancelled it) is preferred and
 * arrives via run.error / the durable status reason; this is the last-resort
 * fallback for the residual paths that record none (a control-signal abort, or
 * a run that predates reason capture), so the trace screen never renders a bare
 * "failed"/"blocked" with an empty error card. Non-terminal runs get null: a
 * running or successful run has no error to show.
 */
function fallbackTerminalError(run: RunDetail): RunError | null {
  if (run.status !== "failed" && run.status !== "blocked") return null;
  const lead =
    run.status === "blocked"
      ? "This run was stopped before it finished"
      : "This run failed";
  return {
    message: `${lead}, but no specific reason was recorded. Check the worker logs for run ${run.id}.`,
  };
}

/** Final response boundary for the legacy run trace. The Workflow world may
 * return raw stacks and provider errors; neither is allowed into the browser. */
export function sanitizeRunDetailForResponse(input: {
  run: RunDetail;
  steps: RunStep[];
}): {
  run: RunDetail;
  steps: RunStep[];
} {
  const error =
    sanitizeRunError(input.run.error, "Workflow execution failed.") ??
    fallbackTerminalError(input.run);
  return {
    run: { ...input.run, error },
    steps: sanitizeRunSteps(input.steps) ?? [],
  };
}
