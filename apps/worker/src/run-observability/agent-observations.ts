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

/**
 * The inputs behind a clarification decision (AIW-267): recorded alongside the
 * agent outcome so a future run's "did it ask, and why" stays diagnosable from
 * the run ID alone, without Slack. ticketDigest/contextDigest are SHA-256
 * digests of the ticket text and retrieved repo/context the model saw, not the
 * raw content, so two runs of the same ticket stay comparable without storing
 * ticket text twice. This whole object still passes through the same
 * sanitizeReplayValue call the rest of the metadata envelope does before it is
 * persisted, so no secret ever needs to be scrubbed here directly.
 */
export interface ClarificationDecisionObservation {
  status: string;
  questions: string[] | null;
  suggestedAnswers: string[] | null;
  ticketDigest: string;
  ticketBytes: number;
  contextDigest: string;
  contextBytes: number;
  harnessProfileHash: string | null;
}

type CollectedTimeoutArtifacts = CollectedPhaseArtifacts & {
  diagnosticSanitization?: {
    stdout: ReplaySanitizationMetadata;
    stderr: ReplaySanitizationMetadata;
  };
};

export type RepositoryWorkflowObservation =
  | {
      event: "selection";
      source: "metadata" | "harness" | "approved" | "pr_trigger" | "definition_pin";
      /** Repositories the provider listing offered this run. Under a pin that
       *  selects providers, the excluded providers are never queried, so this is
       *  already provider-scoped rather than a server-wide total. */
      catalogSize: number;
      selectedCount: number;
      confidence?: "high" | "medium";
      /** Repositories left after the pin narrowed that listing; absent when no
       *  pin applied. The pin itself stays reproducible from the run's immutable
       *  definitionId and definitionVersion. */
      scopedCatalogSize?: number;
    }
  | {
      event: "expansion";
      round: number;
      attachedCount: number;
      totalCount: number;
      cloneDurationMs: number;
    }
  | {
      event: "scope";
      readCount: number;
      writeCount: number;
    }
  | {
      event: "approval_stale";
      reason: "scope_validation_failed";
    }
  | {
      /** A provider's repository listing failed after the bounded retry, so the
       *  catalog selection saw was incomplete. */
      event: "catalog_degraded";
      providers: Array<"github" | "gitlab">;
      /** continued_degraded means a deterministic signal resolved the selection
       *  without the missing catalog; failed_closed means the run stopped rather
       *  than choose from a partial one. */
      outcome: "continued_degraded" | "failed_closed";
    }
  | {
      event: "publication";
      prCount: number;
    };

export async function emitRepositoryWorkflowObservation(
  observations: V2InvocationObservationHooks | undefined,
  value: RepositoryWorkflowObservation,
): Promise<void> {
  if (!observations) return;
  await observations.emit({
    kind: "metadata",
    value: { repositoryWorkflow: value },
  });
}

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
  /** Present only when this invocation reached a structured clarification
   *  decision (AIW-267). Omitted entirely rather than sent as null/undefined,
   *  so it never overwrites a prior invocation's decision on replay. */
  clarificationDecision?: ClarificationDecisionObservation;
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
        ...(input.clarificationDecision
          ? { clarificationDecision: input.clarificationDecision }
          : {}),
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
