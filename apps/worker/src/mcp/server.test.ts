import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { McpToolDependencies } from "./contracts.js";
import { createMcpServer } from "./server.js";

const state = vi.hoisted(() => ({
  executeMcpRead: vi.fn(),
}));

vi.mock("../../env.js", () => ({
  env: {
    MCP_SERVER_VERSION: "0.1.0",
    MCP_MAX_RESULT_BYTES: 524_288,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
  },
}));
vi.mock("./execute-tool.js", () => ({
  executeMcpRead: state.executeMcpRead,
}));

const cleanups: Array<() => Promise<void>> = [];

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
});

describe("createMcpServer", () => {
  it("initializes at the configured version and exposes only system.capabilities", async () => {
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
    const server = createMcpServer(deps);
    const client = new Client({ name: "task-5-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    cleanups.push(() => client.close(), () => server.close());

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    expect(client.getServerVersion()).toEqual({
      name: "ai-workflow-worker",
      version: "0.1.0",
    });
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(["system.capabilities"]);
    expect(listed.tools[0]?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });

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
        enabledDomains: ["system"],
      },
      meta: { trust: "system" },
    });
  });
});
