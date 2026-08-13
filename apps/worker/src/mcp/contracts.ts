import type { Db } from "../db/client.js";
import type { Adapters } from "../lib/adapters.js";

// Four scopes, because an OAuth consent is granted one scope at a time and these
// are four different things to agree to. "prompts:write" is not a subset of the
// first two and must never be folded into either: the prompt library is the
// instruction set every future agent run is handed, so a user who agreed to read
// tickets (mcp:read) and to start runs (runs:dispatch) has not thereby agreed to
// let a client rewrite what those runs are told to do. Separating the scope is the
// only place in this system where that difference can be expressed.
//
// "workflows:write" is the same argument one level up, and it is deliberately not
// runs:dispatch. Firing an existing, reviewed workflow is a request to do what
// somebody already approved; authoring one decides what the system will do with
// other people's repositories, sandboxes and pull requests from then on, and every
// future dispatch of it inherits that decision. A consent screen is the only place
// a user can say yes to one and no to the other.
export const MCP_SCOPES = [
  "mcp:read",
  "runs:dispatch",
  "prompts:write",
  "workflows:write",
] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

// The list has outgrown the first slice: the three discovery tools below were
// added after it shipped, because dispatch_preflight demands a definitionId
// and a triggerNodeId that nothing else could hand out, prompts.update after
// those, as the first tool that authors anything, and the three workflow
// authoring tools last, which close the loop from "no workflow" to a dispatchable
// one. Appended rather than grouped by domain, so the published order of
// everything that shipped before stays byte-identical. The name stays as it is
// on purpose. It is imported in a dozen places and the order of this array is
// the order the contract publishes, so renaming it would move a lot of lines
// without changing a single published byte.
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
  "workflows.list",
  "prompts.list",
  "prompts.get",
  "prompts.update",
  "workflows.create",
  "workflows.save_draft",
  "workflows.publish",
  // Run control, appended last for the same reason everything else was: the
  // published order of what already shipped stays byte-identical. These two are
  // the other half of a dispatch: an agent that can start a run could not until
  // now answer the question that run parks on, nor stop one it started.
  "runs.get_clarification",
  "runs.answer_clarification",
] as const;
export type McpToolName = (typeof FIRST_SLICE_TOOLS)[number];

// An audit row records an ATTEMPT, and an attempt may name a tool that does not
// exist, so the type has to say so rather than let a cast smuggle a foreign
// string in as an McpToolName. Every unrecognized name collapses onto this one
// value: the rate-limit window is keyed by tool name, so bucketing by whatever
// the caller typed would hand each invented name a fresh budget and the limiter
// would stop limiting the one thing it is here to stop. The name the caller
// actually sent survives only as a hash in the row's inputHash.
export const MCP_UNRECOGNIZED_TOOL = "unrecognized" as const;
export type McpAuditToolName = McpToolName | typeof MCP_UNRECOGNIZED_TOOL;

// A runtime list, with the type derived from it, exactly as FIRST_SLICE_TOOLS
// derives McpToolName. The published contract hash has to enumerate the codes an
// agent may receive, and while the list was hand-written next to a union it drifted:
// the hashed list omitted TIMEOUT, so the hash announced a contract the server did
// not implement. Deriving the union from the list makes that divergence a compile
// error rather than a silent one.
export const MCP_ERROR_CODES = [
  "UNAUTHENTICATED",
  "INSUFFICIENT_SCOPE",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "RATE_LIMITED",
  "DEPENDENCY_UNAVAILABLE",
  // Distinct from DEPENDENCY_UNAVAILABLE on purpose: that one tells a caller the
  // backend is down and to come back later, while this one means the effect may
  // already be running. Those are two different next moves, and a caller has to
  // be able to tell them apart without reading the message.
  "TIMEOUT",
  "INTERNAL_ERROR",
] as const;
export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

export class McpPublicError extends Error {
  constructor(
    readonly code: McpErrorCode,
    safeMessage: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    // Set only by a failure raised before the effect could be applied, so a
    // retry cannot duplicate anything. "retryable" answers a different
    // question: whether the caller may come back, not whether the work stayed
    // undone. A mutation may only give an idempotency key back on this one,
    // because guessing wrong here means a second run on somebody's ticket.
    readonly effectNotApplied: boolean = false,
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
  toolName: McpAuditToolName;
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

export type McpRunSummary = {
  runId: string;
  workflowName: string;
  status: "success" | "running" | "failed" | "blocked" | "awaiting";
  terminal: boolean;
  ticketKey: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationSec: number | null;
};

// The repo disagrees with itself about whether "awaiting" is terminal:
// db/queries/run-detail-read.ts:23 treats it as terminal (a parked run has
// stopped executing steps), run-observability/store.ts:309-313 does not. For
// MCP we side with run-detail-read: "awaiting" means the run is waiting on a
// human, so a polling agent must stop, not keep looping. Do not "fix" this
// back to match store.ts.
export function isTerminalRunStatus(status: McpRunSummary["status"]): boolean {
  return (
    status === "success" ||
    status === "failed" ||
    status === "blocked" ||
    status === "awaiting"
  );
}
