import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../env.js", () => ({
  env: {
    MCP_SERVER_VERSION: "0.1.0",
    MCP_MAX_RESULT_BYTES: 524_288,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
    MCP_AUDIT_RETENTION_DAYS: 365,
    JIRA_BASE_URL: "https://blazity.atlassian.net",
  },
}));

import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import { organization, workflowRuns } from "../../db/schema.js";
import { depsFor } from "../test-support.js";
import { registerRunStatsTools } from "./run-stats.js";

const NOW = new Date("2026-08-16T12:00:00.000Z");

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
  const server = new McpServer({ name: "run-stats-test", version: "0.1.0" });
  registerRunStatsTools(server, depsFor(db, () => NOW));
  const client = new Client({ name: "run-stats-test-client", version: "1.0.0" });
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

let runSeq = 0;
async function seedRun(over: {
  status?: string;
  ticketKey?: string | null;
  startedAt: Date;
  durationSec?: number | null;
  costUsd?: number | null;
  tokensInput?: number | null;
  tokensOutput?: number | null;
}): Promise<string> {
  runSeq += 1;
  const runId = `wrun_${runSeq}`;
  await db.insert(workflowRuns).values({
    runId,
    workflowId: "wf_agent",
    workflowName: "Agent",
    status: over.status ?? "success",
    ticketKey: over.ticketKey === undefined ? "PROJ-1" : over.ticketKey,
    startedAt: over.startedAt,
    durationSec: over.durationSec ?? 120,
    costUsd: over.costUsd ?? null,
    tokensInput: over.tokensInput ?? null,
    tokensOutput: over.tokensOutput ?? null,
  });
  return runId;
}

async function callStats(args: { window?: string; limit?: number } = {}): Promise<ToolResult> {
  const client = await connectedClient();
  return client.callTool({ name: "runs.stats", arguments: args });
}

describe("runs.stats", () => {
  it("rolls up recent run outcomes with the same aggregate cost costAgg computes", async () => {
    await seedRun({
      ticketKey: "PROJ-1",
      startedAt: new Date("2026-08-16T09:00:00.000Z"), // 3h before NOW
      durationSec: 120,
      costUsd: 1.5,
      tokensInput: 1000,
      tokensOutput: 500,
    });
    await seedRun({
      status: "failed",
      ticketKey: "PROJ-2",
      startedAt: new Date("2026-08-16T10:00:00.000Z"), // 2h before NOW
      durationSec: 60,
      costUsd: 0.75,
    });
    // Outside the default 24h window (6 days before NOW): must not appear in
    // either the outcomes page or the aggregate.
    await seedRun({
      ticketKey: "PROJ-OLD",
      startedAt: new Date("2026-08-10T09:00:00.000Z"),
      costUsd: 100,
    });

    const result = await callStats();
    const data = dataOf(result);

    expect(result.isError).not.toBe(true);
    expect(data.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workflowName: "Agent",
          status: "success",
          terminal: true,
          ticketKey: "PROJ-1",
          startedAtMin: 180,
          durationSec: 120,
          costUsd: 1.5,
        }),
        expect.objectContaining({
          workflowName: "Agent",
          status: "failed",
          terminal: true,
          ticketKey: "PROJ-2",
          startedAtMin: 120,
          durationSec: 60,
          costUsd: 0.75,
        }),
      ]),
    );
    expect((data.runs as unknown[]).length).toBe(2);
    expect(data.runsTruncated).toBe(false);
    expect(data.cost).toMatchObject({
      totals: { totalTokenCost: 2.25, totalTokens: 1500, traceCount: 2, costPerRun: 1.125 },
    });
  });

  it("truncates the outcomes page without truncating the cost aggregate", async () => {
    for (let i = 0; i < 3; i += 1) {
      await seedRun({
        startedAt: new Date("2026-08-16T09:00:00.000Z"),
        costUsd: 1,
      });
    }

    const result = await callStats({ limit: 2 });
    const data = dataOf(result);

    expect((data.runs as unknown[]).length).toBe(2);
    expect(data.runsTruncated).toBe(true);
    // costAgg has no limit of its own: the aggregate still covers all three.
    expect(data.cost).toMatchObject({ totals: { traceCount: 3 } });
  });

  it("widens to a run outside the default window only when asked", async () => {
    await seedRun({
      ticketKey: "PROJ-OLD",
      startedAt: new Date("2026-08-10T09:00:00.000Z"),
      costUsd: 5,
    });

    const narrow = dataOf(await callStats());
    const wide = dataOf(await callStats({ window: "7d" }));

    expect((narrow.runs as unknown[]).length).toBe(0);
    expect(narrow.cost).toMatchObject({ totals: { traceCount: 0 } });
    expect((wide.runs as unknown[]).length).toBe(1);
    expect(wide.cost).toMatchObject({ totals: { traceCount: 1 } });
  });
});
