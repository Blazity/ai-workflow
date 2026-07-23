import type {
  RunDetail,
  RunError,
  RunStep,
} from "@shared/contracts";
import { EXECUTION_DIAGNOSTIC_PREFIX } from "@shared/contracts";

import { sanitizeReplayValue } from "../../run-observability/sanitizer.js";
import { configuredReplaySecrets } from "../../run-observability/configured-secrets.js";
import { sanitizeDetail } from "../../workflow-definition/failure-message.js";

export function sanitizeRunError(
  error: string | RunError | null | undefined,
  fallback: string,
): RunError | null {
  if (!error) return null;
  const normalized = typeof error === "string" ? { message: error } : error;
  const sanitized = sanitizeReplayValue(normalized.message, {
    secrets: configuredReplaySecrets(),
  });
  const message =
    !sanitized.metadata.unavailable && typeof sanitized.value === "string"
      ? sanitizeDetail(sanitized.value)
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

/** Final response boundary for the legacy run trace. The Workflow world may
 * return raw stacks and provider errors; neither is allowed into the browser. */
export function sanitizeRunDetailForResponse(input: {
  run: RunDetail;
  steps: RunStep[];
}): {
  run: RunDetail;
  steps: RunStep[];
} {
  return {
    run: {
      ...input.run,
      error: sanitizeRunError(
        input.run.error,
        "Workflow execution failed.",
      ),
    },
    steps: sanitizeRunSteps(input.steps) ?? [],
  };
}
