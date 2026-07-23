import type { WorkflowExecutionLogEvent } from "../workflow-definition/interpreter.js";
import type { AgentProtocolDiagnostic } from "../sandbox/agents/types.js";

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
 * Keeps execution logs useful for correlation without letting provider output,
 * schema details, or command tails cross the durable logger-step boundary.
 */
export function safeWorkflowExecutionLogEvent(
  event: WorkflowExecutionLogEvent,
): WorkflowExecutionLogEvent {
  const diagnostic = event.agentProtocol;
  return {
    diagnosticId: event.diagnosticId,
    nodeId: event.nodeId,
    attempt: event.attempt,
    category: event.category,
    ...(event.phase ? { phase: event.phase } : {}),
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
