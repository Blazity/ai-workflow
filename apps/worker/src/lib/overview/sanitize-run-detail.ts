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
  // The message-sized bound, not the snippet one, on both the run and the step
  // path. What arrives here is normally an already-composed message: the generic
  // per-category text, the parenthesised cause snippet and the diagnostic ID.
  // The worst realistic composed length is 294 characters (50 + " (" + 160 + ")"
  // + " Diagnostic ID: " + a 59-character ID), and a block-level message without
  // the ID still reaches 213, both over the 160 a snippet gets. Capping at the
  // snippet length would therefore cut the cause a second time.
  //
  // Some step errors are NOT composed: agent.ts's truncateError path stores a
  // raw 500-character slice. Those get the same 400 deliberately. The bound is
  // not a confidentiality control (redaction runs first and is independent of
  // length, so 400 redacted characters leak nothing 160 would have hidden); it
  // exists so a pathological payload cannot fill the response, and 400 is a
  // short paragraph in the trace screen's error card. Splitting the two paths
  // would buy no safety and would re-break the composed case.
  const message =
    !sanitized.metadata.unavailable && typeof sanitized.value === "string"
      ? sanitizeFailureMessage(sanitized.value)
      : "";
  // Last match, not first: the preserved tail of a clamped message can now carry
  // an inner "Diagnostic ID:" that a head slice used to discard, and the run's
  // own ID is always the trailing one.
  const quotedId = [
    ...normalized.message.matchAll(/Diagnostic ID: (AIW-DIAG-[A-Za-z0-9._:-]+)/g),
  ].at(-1)?.[1];
  const code = normalized.code?.startsWith(EXECUTION_DIAGNOSTIC_PREFIX)
    ? normalized.code
    : quotedId;
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
