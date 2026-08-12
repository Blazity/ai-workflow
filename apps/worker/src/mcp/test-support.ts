import type { Db } from "../db/client.js";
import type { Adapters } from "../lib/adapters.js";
import type { McpActorContext, McpToolDependencies } from "./contracts.js";

export function actorFor(overrides: Partial<McpActorContext> = {}): McpActorContext {
  return {
    kind: "user",
    subject: "user:execute",
    userId: "user-execute",
    clientId: "client-execute",
    organizationId: "org-execute",
    organizationSlug: "execute",
    role: "admin",
    scopes: new Set(["mcp:read", "runs:dispatch"]),
    audience: "https://worker.example.com/mcp",
    ...overrides,
  };
}

export function depsFor(
  db: Db,
  now: () => Date,
  overrides: Partial<McpToolDependencies> = {},
): McpToolDependencies {
  return {
    db,
    adapters: {} as Adapters,
    actor: actorFor(),
    requestId: "request-execute",
    traceId: "trace-execute",
    now,
    ...overrides,
  };
}
