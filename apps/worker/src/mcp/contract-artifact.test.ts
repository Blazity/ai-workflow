import { readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ executeMcpRead: vi.fn() }));

vi.mock("../../env.js", () => ({
  env: {
    MCP_SERVER_VERSION: "0.1.0",
    MCP_MAX_RESULT_BYTES: 524_288,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
    MCP_AUDIT_RETENTION_DAYS: 365,
    MAX_CONCURRENT_AGENTS: 3,
  },
}));
vi.mock("./execute-tool.js", () => ({
  executeMcpRead: state.executeMcpRead,
  executeMcpMutation: vi.fn(),
}));

import type { Db } from "../db/client.js";
import {
  MCP_CONTRACT_ARTIFACT,
  MCP_CONTRACT_SNAPSHOT_PATH,
  mcpContractHash,
  serializeMcpContract,
} from "./contract-artifact.js";
import { createMcpServer } from "./server.js";
import { depsFor } from "./test-support.js";

const committedSnapshot = readFileSync(MCP_CONTRACT_SNAPSHOT_PATH, "utf8");
const committed = JSON.parse(committedSnapshot) as { contractHash: string };

const cleanups: Array<() => Promise<void>> = [];

async function connectedClient(): Promise<Client> {
  const server = createMcpServer(
    depsFor({} as Db, () => new Date("2026-08-12T00:00:00.000Z")),
  );
  const client = new Client({ name: "contract-artifact-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(
    () => client.close(),
    () => server.close(),
  );

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

beforeEach(() => {
  // Passthrough, so system.capabilities answers with what server.ts actually built
  // rather than with a fixture. Everything execute-tool.ts does around that call
  // (audit, rate limit, timeout) is its own test's business.
  state.executeMcpRead.mockImplementation(
    async (input: { operation: (signal: AbortSignal) => Promise<unknown> }) => ({
      data: await input.operation(new AbortController().signal),
      meta: { trust: "external_untrusted" },
    }),
  );
});

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.clearAllMocks();
});

describe("MCP contract artifact", () => {
  // The reason the artifact converts schemas through the SDK's own converter
  // instead of describing them itself: an artifact that agreed with the catalog but
  // not with the wire would document a server nobody is talking to.
  it("describes every tool exactly as tools/list advertises it", async () => {
    const client = await connectedClient();

    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name)).toEqual(
      MCP_CONTRACT_ARTIFACT.tools.map((tool) => tool.name),
    );
    for (const tool of MCP_CONTRACT_ARTIFACT.tools) {
      const advertised = listed.tools.find((candidate) => candidate.name === tool.name);
      expect(advertised?.description).toBe(tool.description);
      expect(advertised?.inputSchema).toEqual(tool.inputSchema);
      expect(advertised?.annotations).toEqual(tool.annotations);
    }
  });

  // A literal, never derived from MCP_ERROR_CODES: this is the list that fails the
  // day a code is added or dropped without intent. TIMEOUT is called out because
  // its absence is the defect this stage fixes -- the hash used to be taken over a
  // hand-written list that omitted it, so the contract published to clients, to the
  // audit table and to system.capabilities described a server that did not exist.
  it("publishes every error code the server can raise, TIMEOUT included", () => {
    expect(MCP_CONTRACT_ARTIFACT.errorCodes).toEqual([
      "UNAUTHENTICATED",
      "INSUFFICIENT_SCOPE",
      "FORBIDDEN",
      "NOT_FOUND",
      "VALIDATION_FAILED",
      "CONFLICT",
      "IDEMPOTENCY_CONFLICT",
      "RATE_LIMITED",
      "DEPENDENCY_UNAVAILABLE",
      "TIMEOUT",
      "INTERNAL_ERROR",
    ]);
  });

  // What makes the committed snapshot worth committing: any change to the surface
  // has to arrive as a regenerated file, so a reviewer sees what a client's view of
  // the contract becomes. Compared as text, so formatting counts too.
  it("is committed exactly as it regenerates", () => {
    expect(committedSnapshot).toBe(serializeMcpContract(MCP_CONTRACT_ARTIFACT));
  });

  // The property the whole artifact exists for, and the one the replaced hash did
  // not have: the hash covers the surface, not only the list of names.
  it("moves the hash when a description changes and nothing else does", () => {
    const [first, ...rest] = MCP_CONTRACT_ARTIFACT.tools;
    const edited = {
      errorCodes: MCP_CONTRACT_ARTIFACT.errorCodes,
      tools: [{ ...first, description: `${first.description} (edited)` }, ...rest],
    };

    expect(mcpContractHash(edited)).not.toBe(MCP_CONTRACT_ARTIFACT.contractHash);
    expect(mcpContractHash(MCP_CONTRACT_ARTIFACT)).toBe(
      MCP_CONTRACT_ARTIFACT.contractHash,
    );
  });

  // Leg one of the three-way. The committed snapshot is the pivot on purpose: it is
  // a file rather than either module's constant, so this and the readiness route's
  // matching assertion (routes/api/v1/system/mcp-readiness.test.ts) together pin
  // the client's view, the operator's view and the artifact to one contract. A
  // rejoined hash is the whole point of the stage: three answers that disagree mean
  // three parties describing different servers.
  it("publishes the contract hash system.capabilities returns", async () => {
    const client = await connectedClient();

    const called = await client.callTool({ name: "system.capabilities", arguments: {} });

    expect(called.isError).not.toBe(true);
    expect(called.structuredContent).toMatchObject({
      data: { contractHash: committed.contractHash },
    });
    expect(MCP_CONTRACT_ARTIFACT.contractHash).toBe(committed.contractHash);
  });
});
