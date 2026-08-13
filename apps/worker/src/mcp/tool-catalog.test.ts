import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../env.js", () => ({
  env: {
    MCP_SERVER_VERSION: "0.1.0",
    MCP_MAX_RESULT_BYTES: 65_536,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
    MCP_AUDIT_RETENTION_DAYS: 365,
    MAX_CONCURRENT_AGENTS: 3,
    JIRA_BASE_URL: "https://blazity.atlassian.net",
    AGENT_KIND: "claude",
    CLAUDE_MODEL: "claude-opus-4-8",
    CODEX_MODEL: "gpt-5.4",
  },
}));

import type { Db } from "../db/client.js";
import { PROMPT_BODY_MAX_LENGTH as STORE_BODY_MAX_LENGTH } from "../prompt-library/store.js";
import { MAX_EDGES, MAX_NODES } from "../workflow-definition/schema.js";
import { FIRST_SLICE_TOOLS } from "./contracts.js";
import { policyFor } from "./policy.js";
import { createMcpServer } from "./server.js";
import { depsFor } from "./test-support.js";
import {
  MCP_ENABLED_DOMAINS,
  MCP_TOOL_CATALOG,
  PROMPT_BODY_MAX_LENGTH,
  WORKFLOW_MAX_EDGES,
  WORKFLOW_MAX_NODES,
  catalogedTool,
} from "./tool-catalog.js";

// A literal, never derived from FIRST_SLICE_TOOLS: this is the list that fails
// the day an entry is added or dropped without intent, and comparing the catalog
// against the constant it is supposed to cover would agree with any drift that
// moved both.
const CATALOGUED = [
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
] as const;

// Captured off the real McpServer, through the real createMcpServer, because the
// set that matters is what the server actually registers. The spy calls through,
// so the SDK still accepts every config it is handed.
function registrations(): Map<string, unknown> {
  const spy = vi.spyOn(McpServer.prototype, "registerTool");
  try {
    createMcpServer(depsFor({} as Db, () => new Date("2026-08-12T00:00:00.000Z")));
    return new Map(spy.mock.calls.map((call) => [call[0], call[1]]));
  } finally {
    spy.mockRestore();
  }
}

describe("MCP tool catalog", () => {
  it("covers the whole published surface and nothing outside it", () => {
    expect(Object.keys(MCP_TOOL_CATALOG).sort()).toEqual([...CATALOGUED].sort());
    expect([...FIRST_SLICE_TOOLS].sort()).toEqual([...CATALOGUED].sort());
  });

  it("reports exactly the domains represented by the published tools", () => {
    const cataloguedDomains = [
      ...new Set(Object.keys(MCP_TOOL_CATALOG).map((name) => name.split(".")[0])),
    ].sort();

    expect([...MCP_ENABLED_DOMAINS].sort()).toEqual(cataloguedDomains);
  });

  it("takes annotations from the policy instead of keeping a second list", () => {
    for (const name of CATALOGUED) {
      expect(MCP_TOOL_CATALOG[name].annotations).toBe(policyFor(name).annotations);
    }
  });

  it.each(CATALOGUED)("rejects an unrecognized argument for %s", async (name) => {
    const definition = catalogedTool(name);
    const result = await definition?.definition.inputSchema.safeParseAsync({
      unrecognizedArgument: 1,
    });

    expect(result?.success).toBe(false);
  });

  // A tools/call may legally omit `arguments` altogether, and the gate parses
  // that absence against this very schema before the SDK does. Pinned here
  // because both consumers read one object: loosening it in the gate alone would
  // wave through a call the SDK then bounces for free.
  it("accepts an absent argument object for the tool that needs none", async () => {
    const result =
      await MCP_TOOL_CATALOG["system.capabilities"].inputSchema.safeParseAsync(undefined);

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({});
  });

  it("resolves only catalogued names, prototype keys included", () => {
    expect(catalogedTool("tickets.get")?.name).toBe("tickets.get");
    expect(catalogedTool("tickets.nope")).toBeNull();
    expect(catalogedTool("constructor")).toBeNull();
    expect(catalogedTool("toString")).toBeNull();
  });

  // Identity, not a deep match: the gate validates against the catalog while
  // the SDK validates against whatever was registered, so a copy that merely
  // looks equal today is the drift this catalog exists to prevent.
  it("registers every catalogued tool with the catalogued definition itself", () => {
    const registered = registrations();

    expect([...registered.keys()].sort()).toEqual([...CATALOGUED].sort());
    for (const [name, config] of registered) {
      expect(config).toBe(MCP_TOOL_CATALOG[name as keyof typeof MCP_TOOL_CATALOG]);
    }
  });

  // The catalog restates the two stores' ceilings instead of importing them, because
  // the transport gate loads it on every request and neither the definition schema
  // (every block module) nor the prompt library (the database schema) belongs there.
  // A restatement is only safe while something fails when it drifts, and drifting
  // BELOW the store is the one that matters: it leaves the surface able to read a
  // prompt or a graph it can never write back. The import that the catalog must not
  // do costs nothing here.
  it("caps a body and a graph at exactly the ceilings the stores enforce", () => {
    expect(PROMPT_BODY_MAX_LENGTH).toBe(STORE_BODY_MAX_LENGTH);
    expect(WORKFLOW_MAX_NODES).toBe(MAX_NODES);
    expect(WORKFLOW_MAX_EDGES).toBe(MAX_EDGES);
  });

  // Closes the window C0 accepted on purpose: a name in the catalog but not
  // registered used to pass the gate and bounce off the SDK for free, and a name
  // registered but not catalogued would be refused as unrecognized while the SDK
  // offers it in tools/list.
  it("keeps the catalog, the published surface and the registered set one set", () => {
    const registered = [...registrations().keys()].sort();

    expect(registered).toEqual(Object.keys(MCP_TOOL_CATALOG).sort());
    expect(registered).toEqual([...FIRST_SLICE_TOOLS].sort());
  });
});
