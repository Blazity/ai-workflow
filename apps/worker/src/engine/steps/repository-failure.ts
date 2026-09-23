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
  /** The legacy global configuration counter, which is what the caller holds at
   *  the moment a checks step throws. It is a coarse marker in a log line and
   *  not a decision: the per-repository profile versions the gate compares are
   *  read when the gate is minted, and a failure never mints one. */
  configurationVersion: number | null,
): Promise<string> {
  "use step";
  const { logger } = await import("../../infra/logger.js");
  const { redactDiagnosticText } = await import("../../sandbox/agents/redact.js");
  const { knownSecretValues } = await import("../../services/integrations/runtime.js");
  // Redacted a second time, deliberately, and with more. The caller redacts
  // before the step boundary with the environment's secrets, which is all
  // workflow scope can see; this pass adds every connected integration's,
  // including one stored in the dashboard. A set that cannot be read throws
  // here, and the caller reports the failure without its cause.
  const secrets = await knownSecretValues();
  const report = prePrChecksFailureReport(error, (value) => redactDiagnosticText(value, secrets));
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
