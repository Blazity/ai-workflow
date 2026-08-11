export const MCP_SCOPES = ["mcp:read", "runs:dispatch"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

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
