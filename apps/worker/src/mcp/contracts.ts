import type { Db } from "../db/client.js";
import type { Adapters } from "../lib/adapters.js";

export const MCP_SCOPES = ["mcp:read", "runs:dispatch"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export const FIRST_SLICE_TOOLS = [
  "system.capabilities",
  "tickets.get",
  "tickets.list_runs",
  "runs.get",
  "runs.trace",
  "runs.result",
  "runs.diagnose",
  "workflows.dispatch_preflight",
  "workflows.dispatch",
] as const;
export type McpToolName = (typeof FIRST_SLICE_TOOLS)[number];

export type McpErrorCode =
  | "UNAUTHENTICATED"
  | "INSUFFICIENT_SCOPE"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "RATE_LIMITED"
  | "DEPENDENCY_UNAVAILABLE"
  | "INTERNAL_ERROR";

export class McpPublicError extends Error {
  constructor(
    readonly code: McpErrorCode,
    safeMessage: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(safeMessage);
    this.name = "McpPublicError";
  }
}

export type McpActorContext = {
  kind: "user" | "service";
  subject: string;
  userId: string | null;
  clientId: string;
  organizationId: string;
  organizationSlug: string;
  role: "owner" | "admin" | "member" | "service";
  scopes: ReadonlySet<McpScope>;
  audience: string;
};

export type McpEnvelope<T> = {
  data: T;
  meta: {
    requestId: string;
    traceId: string;
    serverVersion: string;
    contractHash: string;
    trust: "system" | "tenant" | "external_untrusted";
    truncated: boolean;
    redactions: number;
    nextCursor?: string;
  };
};

export type SanitizeOptions = {
  requestId: string;
  traceId: string;
  trust: McpEnvelope<unknown>["meta"]["trust"];
  maxBytes: number;
  nextCursor?: string;
  secrets?: readonly string[];
};

export type IdempotencyInput = {
  organizationId: string;
  actorSubject: string;
  clientId: string;
  toolName: McpToolName;
  idempotencyKey: string;
  payloadHash: string;
  now: Date;
  expiresAt: Date;
};

export type McpAuditInput = {
  requestId: string;
  traceId: string;
  actor: McpActorContext;
  toolName: McpToolName;
  mutationClass: "read" | "direct" | "confirmed";
  targetRefs: string[];
  inputHash: string;
  outputHash: string | null;
  idempotencyKeyHash: string | null;
  outcome: "attempted" | "success" | "rejected" | "failed";
  errorCode: McpErrorCode | null;
  latencyMs: number;
  occurredAt: Date;
};

export type McpToolDependencies = {
  db: Db;
  adapters: Adapters;
  actor: McpActorContext;
  requestId: string;
  traceId: string;
  now: () => Date;
};
