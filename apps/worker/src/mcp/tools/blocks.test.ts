import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";

vi.mock("../../infra/vcs-config.js", () => ({
  env: {
    MCP_SERVER_VERSION: "0.1.0",
    MCP_MAX_RESULT_BYTES: 524_288,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
    MCP_AUDIT_RETENTION_DAYS: 365,
  },
}));

import { BLOCK_TYPE_SPECS } from "@shared/contracts";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import { organization } from "../../db/schema.js";
import { integrationManifests } from "@integrations/registry";
import { depsFor } from "../../test-support/mcp.js";
import { registerBlockTools } from "./blocks.js";
import { MCP_CLIENT_INLINE_BYTES } from "./page-budget.js";

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

/**
 * Every block type this build offers: core's generated catalog plus the blocks
 * the integrations it ships contribute.
 *
 * Derived rather than frozen, because `blocks.list` answers for the deployment
 * and the second half of that answer appears the day an integration ships. A
 * hard-coded core list passed only while the generated registry was empty, and
 * would have turned red on the stage that added the first one.
 */
const ALL_BLOCK_TYPES = [
  ...Object.keys(BLOCK_TYPE_SPECS),
  ...integrationManifests.flatMap((manifest) => manifest.blocks.map((block) => block.type)),
].sort();

describe("blocks.list", () => {
  it("names every block this deployment offers, one line each", async () => {
    const client = await connectedClient();

    const result = await client.callTool({ name: "blocks.list", arguments: {} });
    const blocks = dataOf(result).blocks as Array<Record<string, unknown>>;

    expect(result.isError).not.toBe(true);
    expect(blocks.map((block) => block.type).sort()).toEqual(ALL_BLOCK_TYPES);
    for (const block of blocks) {
      // The summary and nothing else: the contracts are blocks.get's answer.
      expect(Object.keys(block).sort()).toEqual([
        "available",
        "group",
        "integration",
        "label",
        "purpose",
        "type",
        "unavailableReason",
      ]);
      expect(String(block.label).length).toBeGreaterThan(0);
      expect(String(block.purpose)).not.toContain("\n");
      expect(String(block.purpose).length).toBeLessThanOrEqual(160);
    }
  });

  // Red when: the list carries every block's whole contract again. At 85 KB it
  // went out twice per call and Claude Code wrote it to a file instead of
  // showing it.
  it("fits what a client shows inline, both copies of the envelope included", async () => {
    const client = await connectedClient();

    const result = await client.callTool({ name: "blocks.list", arguments: {} });

    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(MCP_CLIENT_INLINE_BYTES);
  });

  it("narrows to one group", async () => {
    const client = await connectedClient();

    const result = await client.callTool({ name: "blocks.list", arguments: { group: "control" } });
    const blocks = dataOf(result).blocks as Array<{ type: string; group: string }>;

    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((block) => block.group === "control")).toBe(true);
    expect(blocks.map((block) => block.type)).toContain("branch");
  });

  it("narrows to the blocks one integration contributes, or to core's own", async () => {
    const client = await connectedClient();
    const contributed = integrationManifests.flatMap((manifest) =>
      manifest.blocks.map((block) => ({ type: block.type, integration: manifest.id })),
    );

    const core = dataOf(
      await client.callTool({ name: "blocks.list", arguments: { integration: "core" } }),
    ).blocks as Array<{ type: string; integration: string | null }>;

    expect(core.map((block) => block.type).sort()).toEqual(Object.keys(BLOCK_TYPE_SPECS).sort());
    expect(core.every((block) => block.integration === null)).toBe(true);
    for (const { type, integration } of contributed.slice(0, 1)) {
      const one = dataOf(
        await client.callTool({ name: "blocks.list", arguments: { integration } }),
      ).blocks as Array<{ type: string; integration: string | null }>;
      expect(one.map((block) => block.type)).toContain(type);
      expect(one.every((block) => block.integration === integration)).toBe(true);
    }
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

  it("answers NOT_FOUND for a type this deployment does not register, and says where the types are", async () => {
    const client = await connectedClient();

    const result = await client.callTool({
      name: "blocks.get",
      arguments: { type: "not_a_real_block" },
    });

    expect(result.isError).toBe(true);
    expect(errorPayload(result)).toMatchObject({ code: "NOT_FOUND" });
    expect(errorPayload(result).message).toContain("blocks.list");
    expect(errorPayload(result).message).not.toContain("not_a_real_block");
  });

  // Red when: a graph can only be configured by guessing keys, which is how a
  // graph built from the listed defaults saved as deployable on a provider nobody
  // meant to use.
  it("carries the JSON Schema of the block's configuration", async () => {
    const client = await connectedClient();

    const loop = dataOf(await client.callTool({ name: "blocks.get", arguments: { type: "loop" } }));
    const agent = dataOf(
      await client.callTool({ name: "blocks.get", arguments: { type: "planning_agent" } }),
    );

    expect(loop.configurationSchema).toMatchObject({
      type: "object",
      properties: { maxAttempts: expect.any(Object), onExhaust: expect.any(Object) },
    });
    // An agent block also takes a pinned Harness Profile, which lives outside its
    // own parameters and is the way to choose a model for real.
    expect(agent.configurationSchema).toMatchObject({
      type: "object",
      properties: {
        prompt: expect.any(Object),
        harnessProfile: {
          type: "object",
          properties: { profileId: { type: "string" }, version: { type: "integer" } },
        },
      },
    });
  });

  it("carries a configuration schema for every block type, never a missing one", async () => {
    const client = await connectedClient();

    for (const type of ALL_BLOCK_TYPES) {
      const block = dataOf(await client.callTool({ name: "blocks.get", arguments: { type } }));
      expect(block.configurationSchema, type).toMatchObject({ type: "object" });
    }
  });
});
