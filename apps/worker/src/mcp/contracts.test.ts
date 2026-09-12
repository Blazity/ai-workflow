import { describe, expect, it } from "vitest";

import {
  FIRST_SLICE_TOOLS,
  MCP_SCOPES,
  McpPublicError,
} from "./contracts.js";

describe("MCP public contracts", () => {
  it("keeps provider scopes unique and lowercase", () => {
    expect(new Set(MCP_SCOPES).size).toBe(MCP_SCOPES.length);
    expect(MCP_SCOPES).toEqual([
      "mcp:read",
      "runs:dispatch",
      "prompts:write",
      "workflows:write",
      "tickets:write",
      // Appended, never interleaved: this order is what the protected-resource
      // and issuer metadata publish.
      "repositories:write",
      "settings:write",
    ]);
    expect(MCP_SCOPES.every((scope) => scope === scope.toLowerCase())).toBe(true);
  });

  it("exposes only a safe code, message, and retryability", () => {
    const error = new McpPublicError("FORBIDDEN", "Access denied", false);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Access denied");
    expect(error.code).toBe("FORBIDDEN");
    expect(error.retryable).toBe(false);
    expect(JSON.stringify(error)).not.toContain("token");
  });

  it("publishes exactly the tool catalog, in the order the contract hashes", () => {
    expect(FIRST_SLICE_TOOLS).toEqual([
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
      "runs.get_clarification",
      "runs.answer_clarification",
      "runs.cancel",
      "tickets.comment",
      "tickets.transition",
      "tickets.create",
      "blocks.list",
      "blocks.get",
      "runs.stats",
      "workflows.get_graph",
      "workflows.set_enabled",
      "runs.logs",
      "repositories.list",
      "repositories.get",
      "repositories.list_versions",
      "repositories.upsert",
      "repositories.set_enabled",
      "repositories.activate_preview",
      "repositories.activate",
      "repositories.import_preview",
      "repositories.import",
      "repositories.suggest",
      "settings.list",
      "settings.get",
      "settings.set",
      "settings.reset",
    ]);
    expect(new Set(FIRST_SLICE_TOOLS).size).toBe(FIRST_SLICE_TOOLS.length);
  });
});
