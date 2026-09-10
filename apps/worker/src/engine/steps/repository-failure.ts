import {
  type PrePrChecksFailureInput,
  prePrChecksFailureInput,
  prePrChecksFailureReport,
} from "../helpers/repository-failure.js";
import { isRunControlError } from "../helpers/run-control-error.js";

/**
 * Redact, bound and log a Pre-PR checks failure, and return the one sentence
 * the operator is allowed to see.
 *
 * A step, because the logging needs the server: pino may only be used inside a
 * step, never in workflow scope, and the checks themselves are no longer a step
 * (they are launched detached and polled across ticks), so without this the
 * catch in workflow scope could not log at all. The redaction is not what
 * forces a step, it already ran in workflow scope before the boundary.
 */
export async function describePrePrChecksFailureStep(
  error: PrePrChecksFailureInput,
  configurationVersion: number | null,
): Promise<string> {
  "use step";
  const { logger } = await import("../../infra/logger.js");
  const { redactDiagnosticText: redact } = await import("../../sandbox/agents/redact.js");
  // Redacted a second time, deliberately. The caller redacts before the step
  // boundary so the journal never holds a secret; this keeps the step correct
  // on its own terms for any input it is given, and redaction is idempotent.
  const report = prePrChecksFailureReport(error, redact);
  logger.error(
    {
      version: configurationVersion,
      name: report.name,
      cause: report.cause,
      stackTail: report.stackTail,
    },
    "pre_pr_checks_step_failed",
  );
  return report.message;
}
describePrePrChecksFailureStep.maxRetries = 0;

/**
 * The sentence to throw for a Pre-PR checks failure, whatever happens to the
 * reporting path itself.
 */
export async function prePrChecksFailureMessage(
  error: unknown,
  configurationVersion: number | null,
): Promise<string> {
  const input = prePrChecksFailureInput(error);
  try {
    return await describePrePrChecksFailureStep(input, configurationVersion);
  } catch (reportingError) {
    if (isRunControlError(reportingError)) throw reportingError;
    return `The repository scripts step failed (${input.name.slice(0, 60)}), and the cause could not be recorded.`;
  }
}
