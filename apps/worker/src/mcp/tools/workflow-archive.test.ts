// Archiving a workflow over MCP, and taking the archive back. Driven through a real
// MCP client against the real store, next to the read the dashboard's list is built
// from, because an archived definition has to disappear from both in the same way.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canEditWorkflowDefinitions } from "@shared/contracts";

const state = vi.hoisted(() => ({ db: undefined as unknown }));

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
vi.mock("../../db/client.js", () => ({ getDb: () => state.db }));

import type { Db } from "../../db/client.js";
import { listConnectedWorkflowDefinitions } from "../../db/repositories/definitions/connected.js";
import { createTestDb } from "../../db/test-db.js";
import {
  organization,
  workflowDefinitions,
  workflowDefinitionVersions,
} from "../../db/schema.js";
import { unarchiveWorkflowDefinition } from "../../services/workflow-definitions/index.js";
import { actorFor, depsFor } from "../../test-support/mcp.js";
import type { McpActorContext, McpScope } from "../contracts.js";
import { policyFor } from "../policy.js";
import { registerDiscoveryTools } from "./discovery.js";
import { registerWorkflowArchiveTools } from "./workflow-archive.js";
import { registerWorkflowGraphTools } from "./workflow-authoring.js";

const ORG_ID = "org-execute";
const NOW = new Date("2026-09-25T10:00:00.000Z");
const KEY_ONE = "11111111-1111-4111-8111-111111111111";
const KEY_TWO = "22222222-2222-4222-8222-222222222222";
const KEY_THREE = "33333333-3333-4333-8333-333333333333";
const SCOPES: ReadonlySet<McpScope> = new Set(["mcp:read", "workflows:write"]);

let db: Db;
let definitionId: number;

beforeEach(async () => {
  db = await createTestDb();
  state.db = db;
  await db.insert(organization).values({ id: ORG_ID, name: "Execute", slug: "execute" });
  definitionId = await seedDeployedDefinition("[QA] scratch workflow");
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** The smallest v2 graph the store reads back as runnable. */
function graph() {
  return {
    schemaVersion: 2,
    nodes: [
      {
        id: "ticket",
        type: "trigger_ticket_ai",
        name: "Ticket trigger",
        x: 10,
        y: 20,
        configuration: {},
        inputs: {},
        additionalInputs: [],
      },
    ],
    edges: [],
  };
}

/** A disabled definition with one deployed version and a newer draft, so "as it
 *  was" has a deployed pointer, a draft head and a layout to lose. */
async function seedDeployedDefinition(name: string): Promise<number> {
  const [row] = await db
    .insert(workflowDefinitions)
    .values({
      name,
      createdById: "admin",
      createdByLabel: "Admin",
      triggerTypes: ["trigger_ticket_ai"],
      layout: { nodes: { ticket: { x: 10, y: 20 } } },
      layoutRevision: 3,
    })
    .returning({ id: workflowDefinitions.id });
  const id = row!.id;
  for (const version of [1, 2]) {
    await db.insert(workflowDefinitionVersions).values({
      definitionId: id,
      version,
      definition: graph() as never,
      createdById: "admin",
      createdByLabel: "Admin",
    });
  }
  await db
    .update(workflowDefinitions)
    .set({ deployedVersion: 1 })
    .where(eq(workflowDefinitions.id, id));
  return id;
}

async function connectedClient(actor: Partial<McpActorContext> = {}): Promise<Client> {
  const server = new McpServer({ name: "workflow-archive-test", version: "0.1.0" });
  const deps = depsFor(db, () => NOW, {
    actor: actorFor({ organizationId: ORG_ID, scopes: SCOPES, ...actor }),
  });
  registerDiscoveryTools(server, deps);
  registerWorkflowGraphTools(server, deps);
  registerWorkflowArchiveTools(server, deps);
  const client = new Client({ name: "workflow-archive-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(() => client.close(), () => server.close());
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function dataOf<T = Record<string, unknown>>(result: ToolResult): T {
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return (result.structuredContent as { data: T }).data;
}

function errorOf(result: ToolResult): { code: string; message: string; retryable: boolean } {
  expect(result.isError).toBe(true);
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  return (JSON.parse(text) as { error: { code: string; message: string; retryable: boolean } })
    .error;
}

function archive(client: Client, id = definitionId, idempotencyKey = KEY_ONE) {
  return client.callTool({
    name: "workflows.archive",
    arguments: { definitionId: id, idempotencyKey },
  });
}

function unarchive(client: Client, id = definitionId, idempotencyKey = KEY_TWO) {
  return client.callTool({
    name: "workflows.unarchive",
    arguments: { definitionId: id, idempotencyKey },
  });
}

/** Everything about a definition a person could notice, minus the two clocks an
 *  archive necessarily moves. */
async function definitionState(id = definitionId) {
  const [row] = await db
    .select()
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.id, id));
  const { archivedAt: _archivedAt, updatedAt: _updatedAt, ...rest } = row!;
  const versions = await db
    .select()
    .from(workflowDefinitionVersions)
    .where(eq(workflowDefinitionVersions.definitionId, id));
  return { ...rest, versions };
}

async function archivedAt(id = definitionId): Promise<Date | null> {
  const [row] = await db
    .select({ archivedAt: workflowDefinitions.archivedAt })
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.id, id));
  return row!.archivedAt;
}

async function listedIds(client: Client): Promise<{ mcp: number[]; dashboard: number[] }> {
  const listed = dataOf<{ workflows: Array<{ definitionId: number }> }>(
    await client.callTool({ name: "workflows.list", arguments: {} }),
  );
  return {
    mcp: listed.workflows.map((row) => row.definitionId).sort(),
    // The read GET /api/v1/workflow-definitions builds the dashboard's list from.
    dashboard: (await listConnectedWorkflowDefinitions()).map((row) => row.id).sort(),
  };
}

describe("workflows.archive and workflows.unarchive", () => {
  it("archiving and then unarchiving leaves the definition exactly as it was", async () => {
    const client = await connectedClient();
    const before = await definitionState();
    const graphBefore = dataOf(
      await client.callTool({ name: "workflows.get_graph", arguments: { definitionId } }),
    );

    const archived = dataOf(await archive(client));
    expect(archived).toMatchObject({ definitionId, name: "[QA] scratch workflow", archived: true });
    expect(await archivedAt()).not.toBeNull();

    const restored = dataOf(await unarchive(client));
    expect(restored).toMatchObject({
      definitionId,
      name: "[QA] scratch workflow",
      archived: false,
      enabled: false,
      deployedVersion: 1,
      draftRevision: 2,
    });
    expect(await archivedAt()).toBeNull();
    expect(await definitionState()).toEqual(before);
    expect(
      dataOf(await client.callTool({ name: "workflows.get_graph", arguments: { definitionId } })),
    ).toEqual(graphBefore);
  });

  it("drops an archived definition out of workflows.list exactly as out of the dashboard's list, and brings it back", async () => {
    const client = await connectedClient();

    const live = await listedIds(client);
    expect(live.mcp).toEqual(live.dashboard);
    expect(live.mcp).toContain(definitionId);

    await archive(client);
    const gone = await listedIds(client);
    expect(gone.mcp).toEqual(gone.dashboard);
    expect(gone.mcp).not.toContain(definitionId);
    // Retired for authoring too, as the dashboard's detail route 404s it.
    expect(
      errorOf(await client.callTool({ name: "workflows.get_graph", arguments: { definitionId } }))
        .code,
    ).toBe("NOT_FOUND");

    await unarchive(client);
    const back = await listedIds(client);
    expect(back).toEqual(live);
  });

  it("refuses to archive an enabled definition, as the dashboard does, and changes nothing", async () => {
    await db
      .update(workflowDefinitions)
      .set({ enabled: true })
      .where(eq(workflowDefinitions.id, definitionId));
    const before = await definitionState();
    const client = await connectedClient();

    const error = errorOf(await archive(client));

    expect(error.code).toBe("CONFLICT");
    expect(error.message).toBe("Disable the definition before archiving it");
    expect(await archivedAt()).toBeNull();
    expect(await definitionState()).toEqual(before);
  });

  it("refuses to unarchive over a live definition that took the name, and leaves both alone", async () => {
    const client = await connectedClient();
    dataOf(await archive(client));
    const twin = await seedDeployedDefinition("[QA] scratch workflow");

    const error = errorOf(await unarchive(client));

    expect(error.code).toBe("CONFLICT");
    expect(error.message).toContain('"[QA] scratch workflow"');
    expect(await archivedAt()).not.toBeNull();
    expect(await archivedAt(twin)).toBeNull();
  });

  it("answers an unarchive of a definition that is not archived with its current state", async () => {
    const client = await connectedClient();
    const before = await definitionState();

    const data = dataOf(await unarchive(client));

    expect(data).toMatchObject({ definitionId, archived: false });
    expect(await definitionState()).toEqual(before);
  });

  it("answers NOT_FOUND for an id that names no definition, on both tools", async () => {
    const client = await connectedClient();

    expect(errorOf(await archive(client, 999_999)).code).toBe("NOT_FOUND");
    expect(errorOf(await unarchive(client, 999_999)).code).toBe("NOT_FOUND");
  });

  it("replays a repeated call under the same key instead of acting twice", async () => {
    const client = await connectedClient();

    const first = dataOf(await archive(client));
    dataOf(await unarchive(client));
    const replay = dataOf(await archive(client));

    // The replay is the stored first answer, so the unarchive that came between
    // is not undone by a client retrying a lost reply.
    expect(replay).toEqual(first);
    expect(await archivedAt()).toBeNull();
    dataOf(await archive(client, definitionId, KEY_THREE));
    expect(await archivedAt()).not.toBeNull();
  });
});

describe("who may archive a workflow", () => {
  for (const tool of ["workflows.archive", "workflows.unarchive"] as const) {
    it(`refuses a member on ${tool}, as the dashboard's DELETE does, and changes nothing`, async () => {
      if (tool === "workflows.unarchive") {
        dataOf(await archive(await connectedClient()));
      }
      const stamp = await archivedAt();
      const client = await connectedClient({ role: "member" });

      const error = errorOf(
        await client.callTool({
          name: tool,
          arguments: { definitionId, idempotencyKey: KEY_THREE },
        }),
      );

      expect(error.code).toBe("FORBIDDEN");
      expect(await archivedAt()).toEqual(stamp);
    });

    it(`refuses a client-credentials token on ${tool}`, async () => {
      const client = await connectedClient({
        kind: "service",
        role: "service",
        userId: null,
        subject: "client:automation",
      });

      const error = errorOf(
        await client.callTool({
          name: tool,
          arguments: { definitionId, idempotencyKey: KEY_THREE },
        }),
      );

      expect(error.code).toBe("FORBIDDEN");
    });
  }

  it("holds the unarchive rule in the service, with the predicate the dashboard's editor checks", async () => {
    dataOf(await archive(await connectedClient()));

    await expect(
      unarchiveWorkflowDefinition(db, {
        definitionId,
        actor: { role: "member", id: "user-member", label: "Member" },
      }),
    ).rejects.toThrow("Forbidden");
    expect(await archivedAt()).not.toBeNull();

    for (const tool of ["workflows.archive", "workflows.unarchive"] as const) {
      for (const role of ["owner", "admin", "member"] as const) {
        expect(policyFor(tool).roles.includes(role), `${tool} for ${role}`).toBe(
          canEditWorkflowDefinitions(role),
        );
      }
      expect(policyFor(tool).scope).toBe("workflows:write");
    }
  });
});
