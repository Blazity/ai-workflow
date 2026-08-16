import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";

vi.mock("../../../env.js", () => ({
  env: {
    MCP_SERVER_VERSION: "0.1.0",
    MCP_MAX_RESULT_BYTES: 524_288,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
    MCP_AUDIT_RETENTION_DAYS: 365,
    AGENT_KIND: "claude",
    CLAUDE_MODEL: "claude-opus-4-8",
    CODEX_MODEL: "gpt-5.4",
  },
}));

import { BLOCK_TYPE_SPECS } from "@shared/contracts";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import { organization } from "../../db/schema.js";
import { depsFor } from "../test-support.js";
import { registerBlockTools } from "./blocks.js";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(organization).values({ id: "org-execute", name: "Execute", slug: "execute" });
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function connectedClient(): Promise<Client> {
  const server = new McpServer({ name: "blocks-test", version: "0.1.0" });
  // The registry itself is built from env alone -- neither tool queries the
  // database -- but every call still runs through execute-tool.ts's audit and
  // rate-limit bookkeeping, which does, so a real test database is still needed
  // here.
  registerBlockTools(server, depsFor(db, () => new Date("2026-08-16T00:00:00.000Z")));
  const client = new Client({ name: "blocks-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(() => client.close(), () => server.close());
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function dataOf(result: ToolResult): Record<string, unknown> {
  return (result.structuredContent as { data: Record<string, unknown> }).data;
}

function errorPayload(result: ToolResult): { code: string; message: string } {
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  return (JSON.parse(text) as { error: { code: string; message: string } }).error;
}

const ALL_BLOCK_TYPES = Object.keys(BLOCK_TYPE_SPECS).sort();

describe("blocks.list", () => {
  it("covers every WorkflowBlockType with an input and output contract", async () => {
    const client = await connectedClient();

    const result = await client.callTool({ name: "blocks.list", arguments: {} });
    const blocks = dataOf(result).blocks as Array<{
      type: string;
      presentation: { label: string; group: string };
      inputs: Record<string, unknown>;
      output: { schema: unknown; statusVariants: string[] };
    }>;

    expect(result.isError).not.toBe(true);
    expect(blocks.map((block) => block.type).sort()).toEqual(ALL_BLOCK_TYPES);
    for (const block of blocks) {
      expect(block.presentation.label.length).toBeGreaterThan(0);
      expect(typeof block.inputs).toBe("object");
      expect(block.output.schema).toBeDefined();
      expect(block.output.statusVariants.length).toBeGreaterThan(0);
    }
  });

  it("lists the same contract blocks.get returns for one type", async () => {
    const client = await connectedClient();

    const listResult = await client.callTool({ name: "blocks.list", arguments: {} });
    const listed = (dataOf(listResult).blocks as Array<{ type: string }>).find(
      (block) => block.type === "loop",
    );
    const getResult = await client.callTool({ name: "blocks.get", arguments: { type: "loop" } });

    expect(getResult.isError).not.toBe(true);
    expect(dataOf(getResult)).toEqual(listed);
  });
});

describe("blocks.get", () => {
  it("carries a block's presentation, ports and I/O contract", async () => {
    const client = await connectedClient();

    const result = await client.callTool({ name: "blocks.get", arguments: { type: "branch" } });

    expect(result.isError).not.toBe(true);
    expect(dataOf(result)).toMatchObject({
      type: "branch",
      presentation: { group: "control" },
    });
  });

  it("answers NOT_FOUND for a type this deployment does not register", async () => {
    const client = await connectedClient();

    const result = await client.callTool({
      name: "blocks.get",
      arguments: { type: "not_a_real_block" },
    });

    expect(result.isError).toBe(true);
    expect(errorPayload(result)).toMatchObject({ code: "NOT_FOUND" });
  });
});
