import type { SettingsSnapshot } from "@shared/contracts";
import { settingsSnapshotFromEnvironment } from "../services/settings/snapshot.js";
import type { Db } from "../db/types.js";
import type { McpActorContext, McpToolDependencies } from "../mcp/contracts.js";
import { createMcpToolServices } from "../services/mcp/tool-services.js";
import type { Adapters } from "../engine/support/adapters.js";
import { unactivatedRepositoryCatalog } from "./repository-catalog.js";

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

/**
 * Tool dependencies bound to a test database.
 *
 * Production builds the same services from the request's handle; a test passes
 * its own pglite handle here, which is the only reason `createMcpToolServices`
 * takes one at all.
 */
export function depsFor(
  db: Db,
  now: () => Date,
  overrides: Partial<McpToolDependencies> = {},
): McpToolDependencies {
  const settings: SettingsSnapshot =
    overrides.settings ?? settingsSnapshotFromEnvironment();
  return {
    services: createMcpToolServices(db, settings),
    adapters: {} as Adapters,
    actor: actorFor(),
    settings,
    // The bridge, which is what a deployment that has not activated the catalog
    // loads: a test that is about the catalog overrides this with its own. A
    // thunk, like the transport's, so a tool that never dispatches never asks.
    loadRepositoryCatalog: async () => unactivatedRepositoryCatalog(),
    requestId: "request-execute",
    traceId: "trace-execute",
    now,
    ...overrides,
  };
}
