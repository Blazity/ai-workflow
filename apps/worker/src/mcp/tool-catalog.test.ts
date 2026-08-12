import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../env.js", () => ({
  env: {
    MCP_SERVER_VERSION: "0.1.0",
    MCP_MAX_RESULT_BYTES: 65_536,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
    MCP_AUDIT_RETENTION_DAYS: 365,
    JIRA_BASE_URL: "https://blazity.atlassian.net",
    AGENT_KIND: "claude",
    CLAUDE_MODEL: "claude-opus-4-8",
    CODEX_MODEL: "gpt-5.4",
  },
}));

import type { Db } from "../db/client.js";
import { FIRST_SLICE_TOOLS, type McpToolDependencies } from "./contracts.js";
import { policyFor } from "./policy.js";
import { depsFor } from "./test-support.js";
import { MCP_TOOL_CATALOG, catalogedTool } from "./tool-catalog.js";
import { registerRunTools } from "./tools/runs.js";
import { registerTicketTools } from "./tools/tickets.js";

// Seven on purpose, not nine: workflows.dispatch_preflight and workflows.dispatch
// still keep their schemas inline in tools/workflows.ts, and moving them here,
// closing the catalog to the full FIRST_SLICE_TOOLS set and asserting it equals
// what the server actually registers, is C1's step. Do not "fix" this list up to
// nine before that move happens; it is the literal that fails the day an entry is
// added or dropped without intent.
const CATALOGUED = [
  "system.capabilities",
  "tickets.get",
  "tickets.list_runs",
  "runs.get",
  "runs.trace",
  "runs.result",
  "runs.diagnose",
] as const;

function registrations(
  register: (server: McpServer, deps: McpToolDependencies) => void,
): Map<string, unknown> {
  const captured = new Map<string, unknown>();
  const server = {
    registerTool: (name: string, config: unknown) => {
      captured.set(name, config);
    },
  } as unknown as McpServer;
  register(server, depsFor({} as Db, () => new Date("2026-08-12T00:00:00.000Z")));
  return captured;
}

describe("MCP tool catalog", () => {
  it("covers the tools whose schemas exist and nothing outside the first slice", () => {
    expect(Object.keys(MCP_TOOL_CATALOG).sort()).toEqual([...CATALOGUED].sort());
    for (const name of Object.keys(MCP_TOOL_CATALOG)) {
      expect(FIRST_SLICE_TOOLS).toContain(name);
    }
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

  it("resolves only catalogued names, prototype keys included", () => {
    expect(catalogedTool("tickets.get")?.name).toBe("tickets.get");
    expect(catalogedTool("tickets.nope")).toBeNull();
    expect(catalogedTool("constructor")).toBeNull();
    expect(catalogedTool("toString")).toBeNull();
  });

  // Identity, not a deep match: the gate validates against the catalog while
  // the SDK validates against whatever was registered, so a copy that merely
  // looks equal today is the drift this catalog exists to prevent.
  it("registers ticket and run tools with the catalogued definition itself", () => {
    const registered = new Map([
      ...registrations(registerTicketTools),
      ...registrations(registerRunTools),
    ]);

    const covered = [...registered.keys()].sort();
    expect(covered).toEqual(
      ["tickets.get", "tickets.list_runs", "runs.get", "runs.trace", "runs.result", "runs.diagnose"].sort(),
    );
    for (const [name, config] of registered) {
      expect(config).toBe(MCP_TOOL_CATALOG[name as keyof typeof MCP_TOOL_CATALOG]);
    }
  });
});
