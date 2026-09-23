import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../infra/vcs-config.js", () => ({
  env: {
    MCP_SERVER_VERSION: "0.1.0",
    MCP_MAX_RESULT_BYTES: 524_288,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
    MCP_AUDIT_RETENTION_DAYS: 365,
    JIRA_BASE_URL: "https://example.atlassian.net",
  },
}));

import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import { organization, workflowRuns } from "../../db/schema.js";
import { depsFor } from "../../test-support/mcp.js";
import { registerRunLogsTool, registerRunTools } from "./runs.js";

/**
 * A run that stopped because an integration it pinned moved under it, read the
 * way an agent reads one.
 *
 * The seam is the durable row, not a stub: S4 writes the sentence and the code
 * into two columns of one statement, and what this stage owes is that an agent
 * asking "why did my run fail?" gets the code rather than prose it would have
 * to pattern-match.
 */
let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  await db
    .insert(organization)
    .values({ id: "org-execute", name: "Execute", slug: "execute" });
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function connectedClient(): Promise<Client> {
  const server = new McpServer({ name: "runs-test", version: "0.1.0" });
  const deps = depsFor(db, () => new Date("2026-09-19T10:00:00.000Z"));
  registerRunTools(server, deps);
  registerRunLogsTool(server, deps);
  const client = new Client({ name: "runs-test-client", version: "1.0.0" });
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

const DISABLED_SENTENCE =
  "Demo was disabled while this run was in flight, so the run stopped at its next use of it. Enable it on the Integrations page and run again.";

async function insertFailedRun(
  runId: string,
  statusReason: string | null,
  statusReasonCode: string | null,
): Promise<void> {
  await db.insert(workflowRuns).values({
    runId,
    workflowId: "wf_agent",
    workflowName: "Agent",
    status: "failed",
    ticketKey: "PROJ-1",
    statusReason,
    statusReasonCode: statusReasonCode as never,
    startedAt: new Date("2026-09-19T09:00:00.000Z"),
    completedAt: new Date("2026-09-19T09:01:00.000Z"),
    durationSec: 60,
    costKnown: true,
  });
}

describe("reading a run an integration stopped", () => {
  it("carries the typed code beside the sentence on runs.result", async () => {
    await insertFailedRun("run-disabled", DISABLED_SENTENCE, "integration_unavailable.disabled");
    const client = await connectedClient();

    const result = await client.callTool({
      name: "runs.result",
      arguments: { runId: "run-disabled" },
    });

    const data = dataOf(result);
    expect(result.isError).not.toBe(true);
    expect(data.result).toMatchObject({
      failureCode: "integration_unavailable.disabled",
      error: { message: DISABLED_SENTENCE },
    });
    // The outcome's shape, pinned: the contract hash covers input schemas and
    // annotations, so a field added to or dropped from a response moves nothing
    // a client could check against.
    expect(Object.keys(data.result as object).sort()).toEqual([
      "completedAt",
      "durationSec",
      "error",
      "failureCode",
      "prNumber",
      "prUrl",
      "prs",
    ]);
  });

  it("leaves failureCode null for a failure that carries no code", async () => {
    await insertFailedRun("run-plain", "Something else went wrong.", null);
    const client = await connectedClient();

    const result = await client.callTool({
      name: "runs.result",
      arguments: { runId: "run-plain" },
    });

    expect((dataOf(result).result as Record<string, unknown>).failureCode).toBeNull();
  });

  it("tells an agent something different for each of the three reasons", async () => {
    const cases = [
      ["run-a", "integration_unavailable.disabled"],
      ["run-b", "integration_unavailable.disconnected"],
      ["run-c", "integration_unavailable.reconfigured"],
    ] as const;
    for (const [runId, code] of cases) {
      await insertFailedRun(runId, "A sentence nobody should match on.", code);
    }
    const client = await connectedClient();

    const actionsByCode = new Map<string, string>();
    for (const [runId, code] of cases) {
      const result = await client.callTool({
        name: "runs.diagnose",
        arguments: { runId },
      });

      const data = dataOf(result);
      expect(data).toMatchObject({
        category: "integration_unavailable",
        confidence: "high",
      });
      expect(data.evidenceRefs).toContain(code);
      actionsByCode.set(code, (data.nextActions as string[]).join(" "));
    }

    // Three reasons an agent answers differently: one asks a person to enable,
    // one to reconnect, and one asks for nothing but a re-run.
    expect(new Set(actionsByCode.values()).size).toBe(3);
    expect(actionsByCode.get("integration_unavailable.disabled")).toContain("enable it");
    expect(actionsByCode.get("integration_unavailable.disconnected")).toContain("reconnect it");
    expect(actionsByCode.get("integration_unavailable.reconfigured")).toContain(
      "Nothing is broken",
    );
  });

  it("still diagnoses a coded failure when its sentence looks like another category", async () => {
    // The prose rules match on leads other paths own; a run stopped by an
    // integration must not be diagnosed by whatever its sentence happens to
    // start with, which is the whole reason the code exists.
    await insertFailedRun(
      "run-masked",
      "Workflow did not start within 10 minutes.",
      "integration_unavailable.disconnected",
    );
    const client = await connectedClient();

    const result = await client.callTool({
      name: "runs.diagnose",
      arguments: { runId: "run-masked" },
    });

    expect(dataOf(result)).toMatchObject({ category: "integration_unavailable" });
  });

  it("carries the code on the debug read, beside the verbatim reason", async () => {
    await insertFailedRun("run-logs", DISABLED_SENTENCE, "integration_unavailable.disabled");
    const client = await connectedClient();

    const result = await client.callTool({
      name: "runs.logs",
      arguments: { runId: "run-logs" },
    });

    expect(dataOf(result)).toMatchObject({
      statusReason: DISABLED_SENTENCE,
      failureCode: "integration_unavailable.disabled",
    });
  });
});
