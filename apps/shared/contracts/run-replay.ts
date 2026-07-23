import type {
  JsonValue,
  WorkflowBlockType,
} from "./domain.js";

export type ReplayAvailability = "available" | "not_captured" | "expired";

export type ReplayCaptureStatus = "available" | "unavailable";

export type ReplayAttemptState =
  | "running"
  | "waiting_loop"
  | "waiting_for_clarification"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped";

export type ReplayObservationKind = "input" | "output" | "log" | "metadata";

export type ReplayRedactionClass =
  | "hard_exclusion"
  | "configured_secret"
  | "token"
  | "jwt"
  | "private_key"
  | "credential_url"
  | "email"
  | "phone"
  | "payment_card"
  | "iban"
  | "payment_identifier"
  | "command_argument";

export interface ReplaySanitizationMetadata {
  redactions: Partial<Record<ReplayRedactionClass, number>>;
  truncated: boolean;
  originalBytes: number;
  storedBytes: number;
  unavailable: boolean;
  unavailableReason: "serialization" | "traversal_limit" | "size_limit" | null;
}

export interface ReplaySanitizedEnvelope {
  value: JsonValue;
  metadata: ReplaySanitizationMetadata;
}

export interface ReplayAttemptOutcome {
  kind: "completed" | "failed" | "cancelled" | "skipped" | "paused";
  status: string;
  details?: JsonValue;
}

export interface WorkflowReplayAttemptSummary {
  id: number;
  nodeId: string;
  attempt: number;
  activationScopeId: string;
  state: ReplayAttemptState;
  outcome: ReplayAttemptOutcome | null;
  selectedTransition: WorkflowReplaySelectedTransition | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  diagnosticId: string | null;
}

export interface WorkflowReplayAttemptDetail
  extends WorkflowReplayAttemptSummary {
  input: ReplaySanitizedEnvelope | null;
  output: ReplaySanitizedEnvelope | null;
  logs: ReplaySanitizedEnvelope | null;
  metadata: ReplaySanitizedEnvelope | null;
}

export interface WorkflowReplaySelectedTransition {
  port: string;
  edgeIds: string[];
}

export interface WorkflowReplayGraphNode {
  id: string;
  type: WorkflowBlockType;
  name: string | null;
  x: number;
  y: number;
}

export interface WorkflowReplayGraphEdge {
  id: string;
  from: string;
  to: string;
  fromPort: string | null;
}

/** Deliberately presentation-only. Prompt text, bindings, block
 * configuration, and executable values never enter replay persistence. */
export interface WorkflowReplayGraphSnapshot {
  nodes: WorkflowReplayGraphNode[];
  edges: WorkflowReplayGraphEdge[];
}

export interface WorkflowReplayLayoutSnapshot {
  nodes: Record<string, { x: number; y: number }>;
  edges?: Record<string, JsonValue>;
}

export interface WorkflowReplaySnapshot {
  runId: string;
  definitionId: number;
  definitionVersion: number;
  definitionSchemaVersion: 1 | 2;
  graph: WorkflowReplayGraphSnapshot;
  layout: WorkflowReplayLayoutSnapshot;
  runtimeManifest: ReplaySanitizedEnvelope;
  captureStatus: ReplayCaptureStatus;
  capturedAt: string;
  expiresAt: string;
}

export interface WorkflowRunReplayResponse {
  availability: ReplayAvailability;
  /** Authoritative durable run lifecycle gate for live polling. */
  mayAdvance: boolean;
  snapshot: WorkflowReplaySnapshot | null;
  attempts: WorkflowReplayAttemptSummary[];
  nextCursor: string | null;
}
