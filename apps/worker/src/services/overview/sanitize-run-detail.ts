import type {
  RunDetail,
  RunError,
  RunStep,
} from "@shared/contracts";
import { EXECUTION_DIAGNOSTIC_PREFIX } from "@shared/contracts";

import { sanitizeReplayValue } from "../../run-observability/sanitizer.js";
import { configuredReplaySecrets } from "../../run-observability/configured-secrets.js";
import {
  isDiagnosticId,
  sanitizeFailureMessage,
} from "../../workflow-definition/failure-message.js";

/** A quoted diagnostic ID inside a failure message. The character class is the
 * one `isDiagnosticId` validates against, deliberately: a wider class here
 * would capture more than the validator can vet, and that disagreement is
 * itself the hole. */
const QUOTED_DIAGNOSTIC_ID = new RegExp(
  `Diagnostic ID: (${EXECUTION_DIAGNOSTIC_PREFIX}[A-Za-z0-9_-]+)`,
  "g",
);

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
  // path. What arrives here is normally an already-composed message: the lead
  // sentence, the parenthesised cause snippet and the diagnostic ID.
  // `deriveFailureMessage` is sized so that whole thing fits the message bound
  // with room reserved for the diagnostic suffix, which makes this call a no-op
  // for every message we compose. That is deliberate, not incidental: Slack and
  // the ticket comment receive the same string WITHOUT this bound, so a clamp
  // that ever fired here would make the surfaces disagree about why a run failed
  // (AIW-254). Capping at the snippet length would cut the cause a second time.
  //
  // Some step errors are NOT composed: agent.ts's truncateError path stores a
  // raw 500-character slice. Those are what the bound is actually for. It is not
  // a confidentiality control (redaction runs first and is independent of
  // length, so the surviving characters leak nothing a shorter cap would have
  // hidden); it exists so a pathological payload cannot fill the response.
  const message =
    !sanitized.metadata.unavailable && typeof sanitized.value === "string"
      ? sanitizeFailureMessage(sanitized.value)
      : "";
  // Read the SANITIZED message, never `normalized.message`. `code` reaches the
  // browser without passing through redaction, so extracting from the raw text
  // would hand back through `code` precisely the secret the line above just
  // removed from `message`. Sanitized, the worst this can capture is something
  // already visible in `message`.
  //
  // Last match, not first: a clamped message can keep an inner "Diagnostic ID:"
  // in its preserved tail, and the run's own ID is always the trailing one.
  const quotedId = [...message.matchAll(QUOTED_DIAGNOSTIC_ID)].at(-1)?.[1];
  // Both candidates are validated as a whole ID, including the runtime-supplied
  // `normalized.code`: it crosses into the response as an identifier, so it gets
  // the same shape check as anything parsed out of message text. A malformed one
  // is dropped, never truncated into something that looks valid.
  const code = [normalized.code, quotedId].find(
    (candidate): candidate is string =>
      candidate !== undefined && isDiagnosticId(candidate),
  );
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
  // Same whole-ID check as sanitizeRunError, not a prefix test: one predicate
  // for every place a diagnostic ID is trusted.
  const diagnosticRunError =
    runError?.code !== undefined && isDiagnosticId(runError.code)
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
