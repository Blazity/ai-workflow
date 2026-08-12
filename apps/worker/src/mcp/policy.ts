import {
  McpPublicError,
  type McpActorContext,
  type McpScope,
  type McpToolName,
} from "./contracts.js";

type McpMutationClass = "read" | "direct" | "confirmed";
type McpRole = McpActorContext["role"];

export type McpToolPolicy = {
  scope: McpScope;
  roles: readonly McpRole[];
  mutation: McpMutationClass;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
};

const READ_POLICY = {
  scope: "mcp:read",
  roles: ["member", "admin", "owner", "service"],
  mutation: "read",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const satisfies McpToolPolicy;

const DISPATCH_POLICY = {
  scope: "runs:dispatch",
  roles: ["admin", "owner", "service"],
  mutation: "direct",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const satisfies McpToolPolicy;

// The one write that changes what OTHER agents are told to do, which is why it
// shares nothing with the dispatch policy above.
//
// Its own scope, because consent is per scope (contracts.ts:4) and rewriting the
// system's instructions is not what a token minted to read tickets and fire runs
// was agreed to do.
//
// And no "service" role, unlike DISPATCH_POLICY. A client_credentials token is
// handed every MCP scope by default (oauth.ts:59), so the role list is the only
// thing standing between an unattended smoke client and a production prompt; an
// automation has no business rewriting one with no human behind it.
const PROMPT_WRITE_POLICY = {
  scope: "prompts:write",
  roles: ["admin", "owner"],
  mutation: "direct",
  annotations: {
    readOnlyHint: false,
    // Nothing is deleted and a pinned {{prompt:slug@N}} keeps resolving to the
    // version it names, but the head this replaces is what every UNPINNED
    // reference resolves for every future run, so a client must not treat it as a
    // safe append it may probe with.
    destructiveHint: true,
    // A repeat under the same idempotency key replays the first answer rather
    // than stacking a second version.
    idempotentHint: true,
    // The effect stays inside this deployment's own library: nothing is started in
    // Jira or the VCS, which is what openWorldHint marks on a dispatch.
    openWorldHint: false,
  },
} as const satisfies McpToolPolicy;

// The highest privilege on this surface. A workflow is the instruction the
// platform executes with its own credentials: whoever writes one decides which
// repositories are cloned, what an agent is told to do inside them and what is
// pushed back. Everything the dispatch policy protects is downstream of it.
//
// Its own scope, for the reason contracts.ts:12 gives: consent to fire a reviewed
// workflow is not consent to write a new one. No "service", for the same reason
// prompts:write refuses it, and oauth.ts keeps the scope out of a
// client_credentials token so an unattended automation cannot hold it at all.
const WORKFLOW_WRITE_POLICY = {
  scope: "workflows:write",
  roles: ["admin", "owner"],
  mutation: "direct",
  annotations: {
    readOnlyHint: false,
    // Creating a definition and saving a draft take nothing away: every save is a
    // new immutable version and no draft is what any trigger fires. Publishing is
    // the one that replaces a live head, and it says so below.
    destructiveHint: false,
    // A repeat under the same idempotency key replays the first answer rather
    // than creating a second definition or stacking a second version.
    idempotentHint: true,
    // Nothing outside this deployment's own tables is touched while a graph is
    // only authored.
    openWorldHint: false,
  },
} as const satisfies McpToolPolicy;

// Publishing is where an authored graph stops being a document. It replaces the
// snapshot every future dispatch resolves against, and store.ts:1211-1212 mints
// the webhook endpoints and syncs the schedule rows of the new head, so a schedule
// node published here starts producing runs from a clock with nobody calling
// anything again. That is an open world and a destructive replacement, and a
// client must not treat it as the safe half of authoring.
const WORKFLOW_PUBLISH_POLICY = {
  ...WORKFLOW_WRITE_POLICY,
  annotations: {
    ...WORKFLOW_WRITE_POLICY.annotations,
    destructiveHint: true,
    openWorldHint: true,
  },
} as const satisfies McpToolPolicy;

const DISPATCH_PREFLIGHT_POLICY = {
  ...READ_POLICY,
  scope: DISPATCH_POLICY.scope,
  roles: DISPATCH_POLICY.roles,
} as const satisfies McpToolPolicy;

const TOOL_POLICY = {
  "system.capabilities": READ_POLICY,
  "tickets.get": READ_POLICY,
  "tickets.list_runs": READ_POLICY,
  "runs.get": READ_POLICY,
  "runs.trace": READ_POLICY,
  "runs.result": READ_POLICY,
  "runs.diagnose": READ_POLICY,
  "workflows.dispatch_preflight": DISPATCH_PREFLIGHT_POLICY,
  "workflows.dispatch": DISPATCH_POLICY,
  // Plain reads, not the dispatch scope: listing what exists is what an agent
  // does BEFORE it knows whether it may dispatch anything, and gating discovery
  // behind runs:dispatch would leave a read-only client unable to name a single
  // definition. Choosing to fire one still costs the dispatch scope.
  "workflows.list": READ_POLICY,
  "prompts.list": READ_POLICY,
  "prompts.get": READ_POLICY,
  "prompts.update": PROMPT_WRITE_POLICY,
  "workflows.create": WORKFLOW_WRITE_POLICY,
  "workflows.save_draft": WORKFLOW_WRITE_POLICY,
  "workflows.publish": WORKFLOW_PUBLISH_POLICY,
} satisfies Record<McpToolName, McpToolPolicy>;

export function policyFor(tool: McpToolName): McpToolPolicy {
  return TOOL_POLICY[tool];
}

export function authorizeTool(actor: McpActorContext, tool: McpToolName): void {
  const policy = policyFor(tool);
  if (!actor.scopes.has(policy.scope)) {
    throw new McpPublicError("INSUFFICIENT_SCOPE", "Insufficient scope", false);
  }
  if (!policy.roles.includes(actor.role)) {
    throw new McpPublicError("FORBIDDEN", "Access denied", false);
  }
}
