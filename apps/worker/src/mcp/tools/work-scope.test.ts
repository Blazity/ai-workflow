import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { createTestDb } from "../../db/test-db.js";
import { organization, repositories, repositoryCatalogState, user } from "../../db/schema.js";
import type { McpActorContext, McpScope } from "../contracts.js";
import { actorFor, depsFor } from "../../test-support/mcp.js";
import { registerWorkScopeTools } from "./work-scope.js";

const ORG_ID = "org-execute";
const NOW = new Date("2026-09-16T10:00:00.000Z");
const SUBJECT = "ticket:jira:AIW-401";
const API = "github:acme/api";
const WEB = "github:acme/web";
const OFFERED = "github:acme/offered";

const KEY_ONE = "11111111-1111-4111-8111-111111111111";
const KEY_TWO = "22222222-2222-4222-8222-222222222222";
const KEY_THREE = "33333333-3333-4333-8333-333333333333";

/** An edit needs this scope and nothing else, so the happy path with only it is
 *  what proves the tool is not quietly riding on mcp:read. */
const DISPATCH_ONLY: ReadonlySet<McpScope> = new Set(["runs:dispatch"]);
const READ_ONLY: ReadonlySet<McpScope> = new Set(["mcp:read"]);

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  state.db = db;
  await db.insert(organization).values({ id: ORG_ID, name: "Execute", slug: "execute" });
  await db.insert(user).values({
    id: "user-execute",
    name: "Ada Lovelace",
    email: "ada@example.com",
    emailVerified: true,
  });
  await db.insert(repositoryCatalogState).values({ id: 1, activated: true });
  await db
    .insert(repositories)
    .values({ provider: "github", path: "acme/api", source: "manual", enabled: true });
  await db
    .insert(repositories)
    .values({ provider: "github", path: "acme/web", source: "manual", enabled: true });
  await db
    .insert(repositories)
    .values({ provider: "github", path: "acme/offered", source: "manual", enabled: false });
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function connectedClient(
  actorOverrides: Partial<McpActorContext> = {},
): Promise<Client> {
  const server = new McpServer({ name: "work-scope-test", version: "0.1.0" });
  registerWorkScopeTools(
    server,
    depsFor(db, () => NOW, {
      actor: actorFor({
        organizationId: ORG_ID,
        role: "member",
        scopes: new Set(["mcp:read", "runs:dispatch"]),
        ...actorOverrides,
      }),
    }),
  );
  const client = new Client({ name: "work-scope-test-client", version: "1.0.0" });
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

function errorOf(result: ToolResult): { code: string; message: string } {
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  return (JSON.parse(text) as { error: { code: string; message: string } }).error;
}

function edit(
  client: Client,
  changes: unknown,
  expectedVersion: number,
  idempotencyKey: string,
  subjectKey = SUBJECT,
): Promise<ToolResult> {
  return client.callTool({
    name: "work_scope.edit",
    arguments: { subjectKey, expectedVersion, changes, idempotencyKey },
  });
}

describe("work_scope.edit", () => {
  it("selects a repository as the person's own decision", async () => {
    const client = await connectedClient({ scopes: DISPATCH_ONLY });

    const result = await edit(
      client,
      [{ repositoryKey: API, action: "select", rationale: "the fix lives here" }],
      0,
      KEY_ONE,
    );

    expect(result.isError).not.toBe(true);
    expect(dataOf(result).scope).toMatchObject({
      subjectKey: SUBJECT,
      version: 1,
      entries: [
        {
          repositoryKey: API,
          state: "selected",
          origin: "person",
          rationale: "the fix lives here",
          // Names the client, not the platform, exactly as answering a
          // clarification through this surface does.
          decidedBy: { kind: "person", actorLabel: "MCP client-execute" },
        },
      ],
    });
    // The record and nothing else. What this path cannot check is true of every
    // edit it accepts, so it is stated once in the tool description rather than
    // echoed back on each reply as though it were news about this one.
    expect(Object.keys(dataOf(result))).toEqual(["scope"]);
  });

  it("excludes a repository", async () => {
    const client = await connectedClient();

    const result = await edit(client, [{ repositoryKey: WEB, action: "exclude" }], 0, KEY_ONE);

    expect(dataOf(result).scope).toMatchObject({
      entries: [{ repositoryKey: WEB, state: "excluded" }],
    });
  });

  it("removes an entry so the next run may decide again", async () => {
    const client = await connectedClient();
    await edit(client, [{ repositoryKey: WEB, action: "exclude" }], 0, KEY_ONE);

    const result = await edit(client, [{ repositoryKey: WEB, action: "remove" }], 1, KEY_TWO);

    expect(dataOf(result).scope).toMatchObject({ version: 2, entries: [] });
  });

  it("refuses the whole edit when a select names a repository the catalog does not enable", async () => {
    const client = await connectedClient();

    const result = await edit(
      client,
      [
        { repositoryKey: API, action: "select" },
        { repositoryKey: OFFERED, action: "select" },
      ],
      0,
      KEY_ONE,
    );

    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe("VALIDATION_FAILED");
    expect(errorOf(result).message).toContain(OFFERED);
    const read = await client.callTool({
      name: "work_scope.get",
      arguments: { subjectKey: SUBJECT },
    });
    expect(dataOf(read)).toMatchObject({ version: 0, entries: [] });
  });

  it("refuses a stale expected version and says which version to read again", async () => {
    const client = await connectedClient();
    await edit(client, [{ repositoryKey: API, action: "select" }], 0, KEY_ONE);

    const result = await edit(client, [{ repositoryKey: WEB, action: "select" }], 0, KEY_TWO);

    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe("CONFLICT");
    expect(errorOf(result).message).toContain("1");
  });

  it("refuses a subject that carries no record", async () => {
    const client = await connectedClient();

    const result = await edit(
      client,
      [{ repositoryKey: API, action: "select" }],
      0,
      KEY_ONE,
      "schedule:sch_1:1757980800000",
    );

    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe("VALIDATION_FAILED");
  });

  it("refuses a version past what the column can hold without spending the idempotency key", async () => {
    const client = await connectedClient();

    const result = await edit(client, [{ repositoryKey: API, action: "select" }], 2_147_483_648, KEY_ONE);

    expect(result.isError).toBe(true);
    // The key is unspent, so the corrected call may reuse it.
    const corrected = await edit(client, [{ repositoryKey: API, action: "select" }], 0, KEY_ONE);
    expect(corrected.isError).toBeFalsy();
  });

  it("refuses a caller holding no dispatch scope", async () => {
    const client = await connectedClient({ scopes: READ_ONLY });

    const result = await edit(client, [{ repositoryKey: API, action: "select" }], 0, KEY_ONE);

    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe("INSUFFICIENT_SCOPE");
  });

  // A token with no person behind it must not settle a repository decision that
  // is a person's to make, exactly as it must not answer a clarification.
  it("refuses a service actor even with the dispatch scope", async () => {
    const client = await connectedClient({
      kind: "service",
      userId: null,
      role: "service",
      scopes: DISPATCH_ONLY,
    });

    const result = await edit(client, [{ repositoryKey: API, action: "select" }], 0, KEY_ONE);

    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe("FORBIDDEN");
  });

  it("replays the first answer under the same idempotency key", async () => {
    const client = await connectedClient();
    const first = await edit(client, [{ repositoryKey: API, action: "select" }], 0, KEY_ONE);

    const second = await edit(client, [{ repositoryKey: API, action: "select" }], 0, KEY_ONE);

    expect(second.isError).not.toBe(true);
    expect(dataOf(second).scope).toEqual(dataOf(first).scope);
  });
});

describe("work_scope.get", () => {
  it("answers the entries and the trail behind them together", async () => {
    const client = await connectedClient();
    await edit(client, [{ repositoryKey: API, action: "select" }], 0, KEY_ONE);
    await edit(client, [{ repositoryKey: WEB, action: "exclude" }], 1, KEY_TWO);

    const result = await client.callTool({
      name: "work_scope.get",
      arguments: { subjectKey: SUBJECT },
    });
    const data = dataOf(result);

    expect(result.isError).not.toBe(true);
    expect(data).toMatchObject({ subjectKey: SUBJECT, version: 2, nextTrailBeforeId: null });
    expect((data.entries as Array<{ repositoryKey: string; state: string }>).map(
      (entry) => [entry.repositoryKey, entry.state],
    )).toEqual([
      [API, "selected"],
      [WEB, "excluded"],
    ]);
    const trail = data.trail as Array<{ event: { kind: string; entry?: { repositoryKey: string } } }>;
    expect(trail).toHaveLength(2);
    // Newest first, so the decision a person is about to undo is the first line.
    expect(trail[0]?.event.entry?.repositoryKey).toBe(WEB);
  });

  it("answers a subject with no record with the version an edit must expect", async () => {
    const client = await connectedClient({ scopes: READ_ONLY });

    const result = await client.callTool({
      name: "work_scope.get",
      arguments: { subjectKey: SUBJECT },
    });

    expect(dataOf(result)).toEqual({
      subjectKey: SUBJECT,
      carriesRecord: true,
      version: 0,
      entries: [],
      trail: [],
      nextTrailBeforeId: null,
    });
  });

  it("pages the trail", async () => {
    const client = await connectedClient();
    await edit(client, [{ repositoryKey: API, action: "select" }], 0, KEY_ONE);
    await edit(client, [{ repositoryKey: WEB, action: "select" }], 1, KEY_TWO);
    await edit(client, [{ repositoryKey: WEB, action: "remove" }], 2, KEY_THREE);

    const first = dataOf(
      await client.callTool({
        name: "work_scope.get",
        arguments: { subjectKey: SUBJECT, trailLimit: 1 },
      }),
    );
    expect(first.trail).toHaveLength(1);
    expect(first.nextTrailBeforeId).not.toBeNull();

    const second = dataOf(
      await client.callTool({
        name: "work_scope.get",
        arguments: { subjectKey: SUBJECT, trailLimit: 2, trailBefore: first.nextTrailBeforeId },
      }),
    );
    expect(second.trail).toHaveLength(2);
    expect(second.nextTrailBeforeId).toBeNull();
  });

  it("answers a subject kind that keeps no record, rather than refusing a fair question", async () => {
    const client = await connectedClient({ scopes: READ_ONLY });

    const result = await client.callTool({
      name: "work_scope.get",
      arguments: { subjectKey: "schedule:sch_1:1757980800000" },
    });

    expect(result.isError).toBeFalsy();
    expect(dataOf(result)).toMatchObject({
      subjectKey: "schedule:sch_1:1757980800000",
      carriesRecord: false,
      version: 0,
      entries: [],
    });
  });

  it("refuses a trail id past what the column can hold, before it costs a call", async () => {
    const client = await connectedClient({ scopes: READ_ONLY });

    const result = await client.callTool({
      name: "work_scope.get",
      arguments: { subjectKey: SUBJECT, trailBefore: 2_147_483_648 },
    });

    // Refused by the published schema before the tool ran, rather than reaching
    // the store and coming back as its overflow: the text is the SDK's own, not
    // this surface's error envelope.
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain("2147483647");
  });

  it("refuses a caller holding no read scope", async () => {
    const client = await connectedClient({ scopes: DISPATCH_ONLY });

    const result = await client.callTool({
      name: "work_scope.get",
      arguments: { subjectKey: SUBJECT },
    });

    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe("INSUFFICIENT_SCOPE");
  });
});
