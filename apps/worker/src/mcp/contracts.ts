/**
 * The transport's view of the MCP contract.
 *
 * The vocabulary itself (scopes, published tool names, error codes, the actor a
 * verified token resolves to, the audit and idempotency shapes) lives in
 * `services/mcp`, because the services that write those ledgers own it. This file
 * re-publishes every one of those names so the transport, the catalog and the
 * tools keep importing them from one place, and adds the one type that only makes
 * sense up here: what a registered tool is handed when it runs.
 */
import type { Adapters } from "../services/vcs/index.js";
import type { McpActorContext } from "../services/mcp/contracts.js";
import type { McpToolServices } from "../services/mcp/tool-services.js";

// Deliberately the two modules and not the cluster's index.ts. The barrel also
// publishes the ledgers and the tool services, which reach the database client and from
// there the validated environment, so importing it here would make every purely
// declarative consumer (the policy table, the catalog, the result sanitizer)
// depend on a configured deployment just to see a type. Both files below are
// side-effect free.
export {
  MCP_ERROR_CODES,
  MCP_SCOPES,
  MCP_UNRECOGNIZED_TOOL,
  McpPublicError,
  FIRST_SLICE_TOOLS,
  isTerminalRunStatus,
} from "../services/mcp/contracts.js";
export type {
  IdempotencyInput,
  McpActorContext,
  McpAuditInput,
  McpAuditToolName,
  McpEnvelope,
  McpErrorCode,
  McpRunSummary,
  McpScope,
  McpToolName,
  SanitizeOptions,
} from "../services/mcp/contracts.js";

/**
 * What a registered tool is handed when it runs.
 *
 * `services` replaced a raw `Db` handle in stage 6c: a tool decides what to
 * publish and how to render it, never how to reach the database, so the
 * operations it may perform are a closed list it cannot reach past.
 */
export type McpToolDependencies = {
  services: McpToolServices;
  adapters: Adapters;
  actor: McpActorContext;
  requestId: string;
  traceId: string;
  now: () => Date;
};
