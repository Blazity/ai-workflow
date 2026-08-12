import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { McpPublicError, type McpToolDependencies, type McpToolName } from "./contracts.js";
import { policyFor } from "./policy.js";
import { createMcpServer } from "./server.js";

const state = vi.hoisted(() => ({
  executeMcpRead: vi.fn(),
  executeMcpMutation: vi.fn(),
}));

vi.mock("../../env.js", () => ({
  env: {
    MCP_SERVER_VERSION: "0.1.0",
    MCP_MAX_RESULT_BYTES: 524_288,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
    MAX_CONCURRENT_AGENTS: 3,
  },
}));
vi.mock("./execute-tool.js", () => ({
  executeMcpRead: state.executeMcpRead,
  executeMcpMutation: state.executeMcpMutation,
}));

// The literal, not FIRST_SLICE_TOOLS: comparing the published surface against the
// constant it is meant to publish would agree with any drift that moved both.
// tool-catalog.test.ts is where the three sets are pinned to each other.
const PUBLISHED: McpToolName[] = [
  "system.capabilities",
  "tickets.get",
  "tickets.list_runs",
  "runs.get",
  "runs.trace",
  "runs.result",
  "runs.diagnose",
  "workflows.dispatch_preflight",
  "workflows.dispatch",
];

const cleanups: Array<() => Promise<void>> = [];

const deps = {
  db: {} as McpToolDependencies["db"],
  adapters: {} as McpToolDependencies["adapters"],
  actor: {
    kind: "user",
    subject: "user_1",
    userId: "user_1",
    clientId: "client_1",
    organizationId: "org_aiw",
    organizationSlug: "ai-workflow",
    role: "member",
    scopes: new Set(["mcp:read"]),
    audience: "https://worker.example.com/mcp",
  },
  requestId: "request_1",
  traceId: "trace_1",
  now: () => new Date("2026-08-11T12:00:00.000Z"),
} satisfies McpToolDependencies;

beforeEach(() => {
  state.executeMcpRead.mockImplementation(
    async (input: { operation: (signal: AbortSignal) => Promise<unknown> }) => ({
      data: await input.operation(new AbortController().signal),
      meta: {
        requestId: "request_1",
        traceId: "trace_1",
        serverVersion: "0.1.0",
        contractHash: "contract-hash",
        trust: "external_untrusted",
        truncated: false,
        redactions: 0,
      },
    }),
  );
});

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.clearAllMocks();
});

async function connectedClient(): Promise<Client> {
  const server = createMcpServer(deps);
  const client = new Client({ name: "task-5-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(() => client.close(), () => server.close());

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function errorPayload(
  result: Awaited<ReturnType<Client["callTool"]>>,
): Record<string, unknown> {
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  return (JSON.parse(text) as { error: Record<string, unknown> }).error;
}

describe("createMcpServer", () => {
  it("initializes at the configured version and publishes the whole first slice", async () => {
    const client = await connectedClient();

    expect(client.getServerVersion()).toEqual({
      name: "ai-workflow-worker",
      version: "0.1.0",
    });
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...PUBLISHED].sort());
  });

  it("publishes the hints its policy defines, tool by tool", async () => {
    const client = await connectedClient();

    const listed = await client.listTools();
    for (const name of PUBLISHED) {
      const tool = listed.tools.find((candidate) => candidate.name === name);
      expect(tool?.annotations).toEqual(policyFor(name).annotations);
    }
  });

  it("serves system.capabilities as a system-trusted envelope", async () => {
    const client = await connectedClient();

    const called = await client.callTool({
      name: "system.capabilities",
      arguments: {},
    });

    expect(called.isError).not.toBe(true);
    expect(state.executeMcpRead).toHaveBeenCalledOnce();
    expect(state.executeMcpRead).toHaveBeenCalledWith(
      expect.objectContaining({
        deps,
        toolName: "system.capabilities",
        targetRefs: [],
      }),
    );
    expect(called.structuredContent).toMatchObject({
      data: {
        protocolVersions: ["2025-11-25"],
        serverVersion: "0.1.0",
        enabledDomains: ["system", "tickets", "runs", "workflows"],
      },
      meta: { trust: "system" },
    });
  });

  // The whole point of the wrapper: the SDK's own tool-error path forwards the
  // message and drops the code, so an agent had to read prose to decide whether
  // to retry, wait, or stop. The message is unchanged; what it travels with is new.
  it("hands the agent a code, not only prose, when a tool fails", async () => {
    state.executeMcpRead.mockRejectedValue(
      new McpPublicError("RATE_LIMITED", "Rate limit exceeded", true, 42_000),
    );
    const client = await connectedClient();

    const called = await client.callTool({ name: "system.capabilities", arguments: {} });

    expect(called.isError).toBe(true);
    expect(errorPayload(called)).toEqual({
      code: "RATE_LIMITED",
      message: "Rate limit exceeded",
      retryable: true,
      retryAfterMs: 42_000,
    });
    // One source for the error, deliberately: a second copy in structuredContent
    // is a second thing to keep in step.
    expect(called.structuredContent).toBeUndefined();
  });

  it("omits retryAfterMs when the error carries no delay", async () => {
    state.executeMcpRead.mockRejectedValue(
      new McpPublicError("NOT_FOUND", "Ticket not found", false),
    );
    const client = await connectedClient();

    const called = await client.callTool({ name: "system.capabilities", arguments: {} });

    expect(errorPayload(called)).toEqual({
      code: "NOT_FOUND",
      message: "Ticket not found",
      retryable: false,
    });
  });

  // An unexpected throw may carry a host, a query or a credential in its message,
  // so nothing of it survives: same verdict execute-tool.ts already stores.
  it("collapses an unexpected failure onto INTERNAL_ERROR without its text", async () => {
    state.executeMcpRead.mockRejectedValue(
      new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"),
    );
    const client = await connectedClient();

    const called = await client.callTool({ name: "system.capabilities", arguments: {} });

    expect(called.isError).toBe(true);
    expect(errorPayload(called)).toEqual({
      code: "INTERNAL_ERROR",
      message: "Internal error",
      retryable: false,
    });
    expect(JSON.stringify(called)).not.toContain("hunter2");
    expect(JSON.stringify(called)).not.toContain("ECONNREFUSED");
  });
});
