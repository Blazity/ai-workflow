import type { WorkflowExecutionLogEvent } from "../workflow-definition/interpreter.js";
import type { AgentProtocolDiagnostic } from "../sandbox/agents/types.js";
import {
  operatorFailureDetail,
  sanitizeFailureMessage,
} from "../workflow-definition/failure-message.js";

/**
 * Keeps replay metadata useful without persisting provider-controlled text or
 * unsalted hashes derived from raw provider output.
 */
export function safeReplayAgentProtocolMetadata(
  diagnostic: AgentProtocolDiagnostic,
): Record<string, unknown> {
  return {
    provider: diagnostic.provider,
    packageName: diagnostic.packageName,
    cliVersion: diagnostic.cliVersion,
    protocol: diagnostic.protocol,
    phase: diagnostic.phase,
    failureKind: diagnostic.failureKind,
    exitCode: diagnostic.exitCode,
    ...(diagnostic.artifacts
      ? {
          artifacts: {
            stdoutBytes: diagnostic.artifacts.stdoutBytes,
            stderrBytes: diagnostic.artifacts.stderrBytes,
            structuredOutputBytes:
              diagnostic.artifacts.structuredOutputBytes,
          },
        }
      : {}),
  };
}

/**
 * Keeps execution logs useful for correlation without letting raw provider
 * output, schema details, or command tails cross the durable logger-step
 * boundary.
 *
 * `detail` is the one exception, and it is the whole point of this record. The
 * customer-facing failure message carries only a short snippet of the same
 * detail, which is not enough to diagnose a real failure: this log line, keyed
 * by the same diagnostic ID the message quotes, is the only place the rest of
 * the cause survives. It is not raw. `operatorFailureDetail` applies the same
 * secret/PII redaction as the customer-facing snippet, strips stack frames, and
 * hard-caps the result, so it stays one bounded field per failure. The
 * genuinely unbounded provider text (`agentProtocol` stdout/stderr tails,
 * nested detail, schema issues) is still dropped here; it reaches the replay
 * store through observations instead.
 *
 * `message` joins `detail` as the second allowed text field because it is
 * exactly the derived string every customer surface already shows; passing it
 * through sanitizeFailureMessage again is a boundary re-assertion, not a
 * second truncation (AIW-312).
 */
export function safeWorkflowExecutionLogEvent(
  event: WorkflowExecutionLogEvent,
): WorkflowExecutionLogEvent {
  const diagnostic = event.agentProtocol;
  const detail = event.detail ? operatorFailureDetail(event.detail) : "";
  return {
    diagnosticId: event.diagnosticId,
    nodeId: event.nodeId,
    attempt: event.attempt,
    category: event.category,
    ...(event.phase ? { phase: event.phase } : {}),
    ...(detail ? { detail } : {}),
    ...(event.message ? { message: sanitizeFailureMessage(event.message) } : {}),
    ...(diagnostic
      ? {
          agentProtocol: {
            provider: diagnostic.provider,
            packageName: diagnostic.packageName,
            cliVersion: diagnostic.cliVersion,
            protocol: diagnostic.protocol,
            phase: diagnostic.phase,
            failureKind: diagnostic.failureKind,
            exitCode: diagnostic.exitCode,
          },
        }
      : {}),
  };
}
