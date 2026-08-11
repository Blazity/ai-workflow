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

const TOOL_POLICY = {
  "system.capabilities": READ_POLICY,
  "tickets.get": READ_POLICY,
  "tickets.list_runs": READ_POLICY,
  "runs.get": READ_POLICY,
  "runs.trace": READ_POLICY,
  "runs.result": READ_POLICY,
  "runs.diagnose": READ_POLICY,
  "workflows.dispatch_preflight": READ_POLICY,
  "workflows.dispatch": DISPATCH_POLICY,
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
