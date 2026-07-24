import type {
  AgentProtocolResult,
  CollectedPhaseArtifacts,
  PhaseUsage,
} from "../sandbox/agents/types.js";
import type { ReplaySanitizationMetadata } from "@shared/contracts";
import type { V2InvocationObservationHooks } from "../workflow-definition/invocation-context.js";

const PROVIDER_LOG_TAIL_CHARACTERS = 64 * 1024;

function tail(value: string): string {
  return value.length <= PROVIDER_LOG_TAIL_CHARACTERS
    ? value
    : value.slice(-PROVIDER_LOG_TAIL_CHARACTERS);
}

function diagnosticLogTail(
  value: string,
  structuredOutput: string | null,
): string {
  const withoutStructuredOutput = structuredOutput
    ? value
        .split(structuredOutput)
        .join("[structured output omitted from diagnostic log]")
    : value;
  return tail(withoutStructuredOutput);
}

interface AgentInvocationObservationBase {
  observations: V2InvocationObservationHooks | undefined;
  provider: "claude" | "codex";
  model: string;
  phase: string;
}

type CollectedTimeoutArtifacts = CollectedPhaseArtifacts & {
  diagnosticSanitization?: {
    stdout: ReplaySanitizationMetadata;
    stderr: ReplaySanitizationMetadata;
  };
};

async function emitAgentArtifactObservations(input: AgentInvocationObservationBase & {
  artifacts: CollectedPhaseArtifacts;
  metadata: Record<string, unknown>;
}): Promise<void> {
  if (!input.observations) return;
  if (input.artifacts.stdout) {
    await input.observations.emit({
      kind: "log",
      value: {
        stream: "stdout",
        tail: diagnosticLogTail(
          input.artifacts.stdout,
          input.artifacts.structuredOutput,
        ),
      },
    });
  }
  if (input.artifacts.stderr) {
    await input.observations.emit({
      kind: "log",
      value: {
        stream: "stderr",
        tail: diagnosticLogTail(
          input.artifacts.stderr,
          input.artifacts.structuredOutput,
        ),
      },
    });
  }
  await input.observations.emit({
    kind: "metadata",
    value: {
      provider: input.provider,
      model: input.model,
      phase: input.phase,
      exitCode: input.artifacts.exitCode,
      ...input.metadata,
    },
  });
}

export async function emitAgentInvocationObservations(input: AgentInvocationObservationBase & {
  artifacts: CollectedPhaseArtifacts;
  usage: PhaseUsage | null;
  result: AgentProtocolResult<unknown>;
}): Promise<void> {
  try {
    await emitAgentArtifactObservations({
      ...input,
      metadata: {
        usage: input.usage,
        protocol: input.result.ok
          ? {
              outcome: "ok",
              ...(input.result.event ? { event: input.result.event } : {}),
            }
          : {
              outcome: "error",
              category: input.result.category,
              failureKind: input.result.diagnostic.failureKind,
              event: input.result.diagnostic.event ?? null,
            },
      },
    });
  } catch {
    // Replay capture is best-effort and cannot replace the agent outcome.
  }
}

/**
 * Best-effort timeout diagnostics. A phase can time out after producing useful
 * stdout/stderr but before writing its sentinel or structured result. Capture
 * those bounded tails without parsing an incomplete provider response.
 */
export async function emitTimedOutAgentInvocationObservations(
  input: AgentInvocationObservationBase & {
    collectArtifacts: () => Promise<CollectedTimeoutArtifacts>;
  },
): Promise<void> {
  if (!input.observations) return;
  let artifacts: CollectedTimeoutArtifacts;
  try {
    artifacts = await input.collectArtifacts();
  } catch {
    try {
      await input.observations.emit({
        kind: "metadata",
        value: {
          provider: input.provider,
          model: input.model,
          phase: input.phase,
          exitCode: null,
          usage: null,
          protocol: {
            outcome: "timeout",
            partialArtifacts: "unavailable",
          },
        },
      });
    } catch {
      // Replay capture is best-effort and cannot replace the timeout outcome.
    }
    return;
  }
  try {
    await emitAgentArtifactObservations({
      ...input,
      artifacts,
      metadata: {
        usage: null,
        protocol: {
          outcome: "timeout",
          partialArtifacts: "captured",
          ...(artifacts.diagnosticSanitization
            ? { sanitization: artifacts.diagnosticSanitization }
            : {}),
        },
      },
    });
  } catch {
    // Replay capture is best-effort and cannot replace the timeout outcome.
  }
}
