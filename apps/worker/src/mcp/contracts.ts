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
import type { SettingsSnapshot } from "@shared/contracts";
import type { Adapters } from "../services/vcs/adapters.js";
import type { McpActorContext } from "../services/mcp/contracts.js";
import type { McpToolServices } from "../services/mcp/tool-services.js";
// Type-only, so it is erased and adds no runtime edge: the paragraph below is
// about modules this file would actually load.
import type { RepositoryCatalogSnapshot } from "../services/repository-catalog/index.js";
import type { DeploymentIntegrations } from "../services/workflow-definitions/block-contracts.js";

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
  isRunCompletionPending,
  isTerminalRunStatus,
} from "../services/mcp/contracts.js";
export type {
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
  /** The deployment's settings as the transport read them for this call. One
   *  load per request, so every tool in it sees the same limits. */
  settings: SettingsSnapshot;
  /**
   * The repository catalog, on demand.
   *
   * A thunk rather than a value, because most tools here read runs, tickets and
   * logs and have no dispatch decision to make: loading the catalog for every
   * call would put one more table between `runs_logs` and its answer, and a
   * catalog read that fails would take the whole surface down with it. The
   * transport memoises the load on the request, so the tools that DO decide (a
   * dispatch, a save, a publish) still share one snapshot within a call.
   */
  loadRepositoryCatalog: () => Promise<RepositoryCatalogSnapshot>;
  /**
   * What this deployment's integrations are in a state to do, on demand.
   *
   * A thunk for the same reason the catalog above is one, and read here rather
   * than inside the tools so the call decides where the state comes from: the
   * transport passes the connected read, and a test passes a value. The tools
   * used to reach a database through a function that read like a catalog
   * question, which meant the whole surface needed a DATABASE_URL the moment
   * this build shipped its first integration.
   */
  loadDeploymentIntegrations: () => Promise<DeploymentIntegrations>;
  /**
   * Every secret this deployment knows, which every result is redacted with
   * before it leaves (`knownSecretValues`: the environment's and every
   * connected integration's, a token stored in the dashboard included). A
   * thunk for the reason the two above are: the transport passes the connected
   * read, a test passes a value. It throws when the integration settings cannot
   * be read, and the call is refused before anything runs.
   */
  loadKnownSecrets: () => Promise<string[]>;
  requestId: string;
  traceId: string;
  now: () => Date;
};
