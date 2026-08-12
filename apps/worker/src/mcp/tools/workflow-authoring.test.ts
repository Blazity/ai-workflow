import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { asc, eq, gte } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The MCP fields the execute wrapper reads, plus the deployment facts the workflow
// block registry resolves a graph against (mirroring workflow-definition/
// store-v2.test.ts): a definition is validated against what this deployment can
// actually run, so the providers have to be configured or every deploy fails for a
// reason that has nothing to do with these tools. WEBHOOK_TRIGGER_ENCRYPTION_KEY
// stays unset, which is what keeps the endpoint mint on the deploy path a no-op.
vi.mock("../../../env.js", () => ({
  env: {
    MCP_SERVER_VERSION: "0.1.0",
    MCP_MAX_RESULT_BYTES: 65_536,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
    MCP_AUDIT_RETENTION_DAYS: 365,
    AGENT_KIND: "claude",
    CLAUDE_MODEL: "claude-test",
    CODEX_MODEL: "codex-test",
    ANTHROPIC_API_KEY: "sk-ant-test",
    CODEX_API_KEY: "sk-codex-test",
    GITHUB_APP_ID: 1,
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_INSTALLATION_ID: 2,
    GITLAB_TOKEN: "gitlab-token",
  },
}));

import type { Adapters } from "../../lib/adapters.js";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import {
  mcpAuditEvents,
  organization,
  workflowDefinitions,
  workflowDefinitionVersions,
} from "../../db/schema.js";
import type { McpActorContext, McpScope } from "../contracts.js";
import { actorFor, depsFor } from "../test-support.js";
import { registerWorkflowAuthoringTools } from "./workflow-authoring.js";

const ORG_ID = "org-execute";

// Distinctive enough that "the audit row does not contain the graph" is a real
// assertion: a marker this shape appears nowhere else in the schema, so a passing
// not.toContain cannot be passing by accident. It rides on a node's display name,
// which is part of the stored graph.
const MARKER = "MARKER-7c4e2a";

const KEY_ONE = "11111111-1111-4111-8111-111111111111";
const KEY_TWO = "22222222-2222-4222-8222-222222222222";

// A write needs this scope and nothing else: asserting the successful path with
// ONLY workflows:write is what proves the tools are not quietly riding on
// mcp:read, runs:dispatch or the prompt write.
const WRITE_ONLY: ReadonlySet<McpScope> = new Set(["workflows:write"]);
const EVERY_OTHER_SCOPE: ReadonlySet<McpScope> = new Set([
  "mcp:read",
  "runs:dispatch",
  "prompts:write",
]);

const TRIGGER_NODE_ID = "ticket";

/** The smallest graph this deployment will actually deploy: one manually
 *  dispatchable trigger and nothing else, exactly the fixture the store's own v2
 *  tests deploy (workflow-definition/store-v2.test.ts:36). */
function graph(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    nodes: [
      {
        id: TRIGGER_NODE_ID,
        type: "trigger_ticket_ai",
        name: `Ticket trigger ${MARKER}`,
        x: 10,
        y: 20,
        configuration: {},
        inputs: {},
        additionalInputs: [],
      },
    ],
    edges: [],
    ...over,
  };
}

/** Structurally broken: no such block type exists, so the definition schema
 *  refuses it and no version can be written. */
function unknownBlockGraph() {
  return graph({
    nodes: [
      {
        id: "mystery",
        type: "not_a_real_block",
        x: 0,
        y: 0,
        configuration: {},
        inputs: {},
        additionalInputs: [],
      },
    ],
  });
}

/** Passes the definition SCHEMA and fails the DEPLOYMENT gate: "entry" is
 *  reserved for the active trigger input (schema.ts:2537), and only the deployment
 *  validation knows that. A graph that saves as a draft and is then refused at
 *  publish is the observable proof that publish runs the gate the dashboard's
 *  Deploy runs and the draft save does not. */
function reservedIdGraph() {
  return graph({
    nodes: [
      {
        id: "entry",
        type: "trigger_ticket_ai",
        x: 0,
        y: 0,
        configuration: {},
        inputs: {},
        additionalInputs: [],
      },
    ],
  });
}

let db: Db;
let now: Date;
let definitionId: number;

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(organization).values({ id: ORG_ID, name: "Execute", slug: "execute" });
  now = new Date("2026-08-12T12:00:00.000Z");
  definitionId = await seedDefinition("Seeded workflow");
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** A definition row with no version, which is what a fresh create leaves behind.
 *  Inserted directly rather than through the store, so a fixture failure cannot be
 *  mistaken for a failure of the tools under test. */
async function seedDefinition(name: string): Promise<number> {
  const [row] = await db
    .insert(workflowDefinitions)
    .values({ name, createdById: "admin", createdByLabel: "Admin" })
    .returning({ id: workflowDefinitions.id });
  return row!.id;
}

async function seedDraft(id: number, version: number, definition: unknown): Promise<void> {
  await db.insert(workflowDefinitionVersions).values({
    definitionId: id,
    version,
    definition: definition as never,
    createdById: "admin",
    createdByLabel: "Admin",
  });
}

async function connectedClient(actor: Partial<McpActorContext> = { scopes: WRITE_ONLY }) {
  const server = new McpServer({ name: "workflow-authoring-test", version: "0.1.0" });
  registerWorkflowAuthoringTools(
    server,
    depsFor(db, () => now, { actor: actorFor(actor), adapters: {} as Adapters }),
  );
  const client = new Client({ name: "workflow-authoring-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(() => client.close(), () => server.close());
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

async function create(client: Client, over: Record<string, unknown> = {}): Promise<ToolResult> {
  return client.callTool({
    name: "workflows.create",
    arguments: { name: "Agent authored", idempotencyKey: KEY_ONE, ...over },
  });
}

async function saveDraft(client: Client, over: Record<string, unknown> = {}): Promise<ToolResult> {
  return client.callTool({
    name: "workflows.save_draft",
    arguments: {
      definitionId,
      expectedDraftRevision: 0,
      definition: graph(),
      idempotencyKey: KEY_ONE,
      ...over,
    },
  });
}

async function publish(client: Client, over: Record<string, unknown> = {}): Promise<ToolResult> {
  return client.callTool({
    name: "workflows.publish",
    arguments: {
      definitionId,
      expectedDraftRevision: 1,
      expectedDeployedVersion: null,
      idempotencyKey: KEY_ONE,
      ...over,
    },
  });
}

function errorPayload(result: ToolResult): {
  code: string;
  message: string;
  retryable: boolean;
} {
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  return (
    JSON.parse(text) as {
      error: { code: string; message: string; retryable: boolean };
    }
  ).error;
}

function dataOf(result: ToolResult): Record<string, unknown> {
  return (result.structuredContent as { data: Record<string, unknown> }).data;
}

/** Only the definitions this test created. The committed migrations already seed
 *  the platform's own enabled "Ticket workflow", so an unscoped count would be
 *  asserting against that row as much as against ours; ids are serial, so
 *  everything from the fixture onwards is this test's. */
async function definitionRows() {
  return db
    .select({
      id: workflowDefinitions.id,
      name: workflowDefinitions.name,
      enabled: workflowDefinitions.enabled,
      deployedVersion: workflowDefinitions.deployedVersion,
      triggerTypes: workflowDefinitions.triggerTypes,
      label: workflowDefinitions.createdByLabel,
    })
    .from(workflowDefinitions)
    .where(gte(workflowDefinitions.id, definitionId))
    .orderBy(asc(workflowDefinitions.id));
}

async function versionsOf(id: number) {
  return db
    .select({
      version: workflowDefinitionVersions.version,
      definition: workflowDefinitionVersions.definition,
      label: workflowDefinitionVersions.createdByLabel,
    })
    .from(workflowDefinitionVersions)
    .where(eq(workflowDefinitionVersions.definitionId, id))
    .orderBy(asc(workflowDefinitionVersions.version));
}

async function auditRows() {
  return db.select().from(mcpAuditEvents);
}

async function auditedErrorCodes(): Promise<Array<string | null>> {
  return (await auditRows()).map((row) => row.errorCode).filter((code) => code !== null);
}

async function auditedOutcomes(): Promise<string[]> {
  return (await auditRows()).map((row) => row.outcome).sort();
}

describe("workflows.create", () => {
  it("creates one disabled definition with no graph and names the client behind it", async () => {
    const client = await connectedClient();

    const result = await create(client);

    expect(result.isError).not.toBe(true);
    expect(dataOf(result)).toEqual({
      definitionId: expect.any(Number),
      name: "Agent authored",
      // What save_draft takes as expectedDraftRevision for the first save. A new
      // definition has no graph at all, which is why publish refuses it.
      draftRevision: 0,
    });
    const created = (await definitionRows()).find((row) => row.name === "Agent authored");
    expect(created).toMatchObject({
      // Disabled, and nothing on this surface can change that: the graph an agent
      // publishes never starts answering real ticket or pull request events until
      // a person enables the definition.
      enabled: false,
      deployedVersion: null,
      label: "MCP client-execute",
    });
    expect(await versionsOf(created!.id)).toEqual([]);
    expect(await auditedOutcomes()).toEqual(["attempted", "success"]);
  });

  it("repeating the same key creates exactly one definition", async () => {
    const client = await connectedClient();

    const first = await create(client);
    const second = await create(client);

    expect(first.isError).not.toBe(true);
    expect(second.isError).not.toBe(true);
    // Replayed, not re-run: without the idempotency lease the second call would
    // either mint a second definition or fail on the unique name, and neither is
    // the answer a retrying agent should get.
    expect(dataOf(second)).toEqual(dataOf(first));
    expect((await definitionRows()).filter((row) => row.name === "Agent authored")).toHaveLength(1);
  });

  it("refuses the same key carrying a different name", async () => {
    const client = await connectedClient();
    await create(client);

    const result = await create(client, { name: "Something else" });

    expect(result.isError).toBe(true);
    expect(errorPayload(result).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await definitionRows()).map((row) => row.name)).toEqual([
      "Seeded workflow",
      "Agent authored",
    ]);
  });

  it("answers CONFLICT for a name another live definition already uses", async () => {
    const client = await connectedClient();

    const result = await create(client, { name: "Seeded workflow" });

    expect(result.isError).toBe(true);
    expect(errorPayload(result).code).toBe("CONFLICT");
    expect(await definitionRows()).toHaveLength(1);
    expect(await auditedErrorCodes()).toEqual(["CONFLICT"]);
  });
});

describe("workflows.save_draft", () => {
  it("stores the graph as the next draft version without deploying anything", async () => {
    const client = await connectedClient();

    const result = await saveDraft(client);

    expect(result.isError).not.toBe(true);
    expect(dataOf(result)).toEqual({
      definitionId,
      draftRevision: 1,
      graphHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    // The reply carries a digest, never the graph it just stored: this value is
    // kept as the idempotency key's response and hashed into the audit row.
    expect(JSON.stringify(result.structuredContent)).not.toContain(MARKER);
    const versions = await versionsOf(definitionId);
    expect(versions).toHaveLength(1);
    expect(JSON.stringify(versions[0]!.definition)).toContain(MARKER);
    // The definition's own history says who authored it, so an operator reading
    // the version list sees the MCP client rather than an anonymous save.
    expect(versions[0]!.label).toBe("MCP client-execute");
    // A draft is inert: saving one deploys nothing and claims no trigger.
    expect(await definitionRows()).toMatchObject([
      { deployedVersion: null, triggerTypes: [] },
    ]);
  });

  it("keeps the graph out of the audit trail and records the definition and revision instead", async () => {
    const client = await connectedClient();

    await saveDraft(client);

    // The graph IS stored (asserted above and again here), so the absence below is
    // the audit row's doing and not the test failing to write anything.
    expect(JSON.stringify((await versionsOf(definitionId))[0]!.definition)).toContain(MARKER);
    const rows = await auditRows();
    expect(JSON.stringify(rows)).not.toContain(MARKER);
    for (const row of rows) {
      // Which definition, and which revision the save replaced. The graph survives
      // only as a digest, in the hashes beside it.
      expect(row.targetRefs).toEqual([String(definitionId), "0"]);
      expect(row.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(row.mutationClass).toBe("direct");
    }
    expect(rows.map((row) => row.outputHash).filter((hash) => hash !== null)).toHaveLength(1);
  });

  it("refuses a graph the definition schema rejects and writes no version", async () => {
    const client = await connectedClient();

    const result = await saveDraft(client, { definition: unknownBlockGraph() });

    expect(result.isError).toBe(true);
    expect(errorPayload(result).code).toBe("VALIDATION_FAILED");
    // The message says what is wrong with the graph, in the same words the
    // dashboard editor shows, and names no file, no query and no stack.
    // The issue is reported against the block that carries it, because the union
    // of the two stored shapes would otherwise say only "invalid_union" at the
    // root and leave an agent nothing to fix.
    expect(errorPayload(result).message).toContain(
      "/nodes/0/type: Unknown workflow block type.",
    );
    expect(errorPayload(result).message).not.toContain("workflow-definition/");
    expect(await versionsOf(definitionId)).toEqual([]);
    expect(await auditedErrorCodes()).toEqual(["VALIDATION_FAILED"]);
  });

  it("refuses a stale draft revision, writes nothing, and leaves the key usable for the corrected save", async () => {
    const client = await connectedClient();
    // Somebody else saved revision 1 while this caller was still holding 0.
    await seedDraft(definitionId, 1, graph());

    const stale = await saveDraft(client);

    expect(stale.isError).toBe(true);
    expect(errorPayload(stale).code).toBe("CONFLICT");
    // The store's own compare-and-set, which is a predicate inside the insert
    // rather than a read before it: the other writer's graph is not replaced.
    expect(errorPayload(stale).message).toContain("reload before saving");
    expect(await versionsOf(definitionId)).toHaveLength(1);

    // Refused before anything was inserted, so the key is provably unspent and
    // the corrected save may reuse it rather than being frozen out for a day.
    const corrected = await saveDraft(client, { expectedDraftRevision: 1 });

    expect(corrected.isError).not.toBe(true);
    expect(dataOf(corrected)).toMatchObject({ draftRevision: 2 });
    expect((await versionsOf(definitionId)).map((row) => row.version)).toEqual([1, 2]);
  });

  it("repeating the same key with the same graph stores exactly one version", async () => {
    const client = await connectedClient();

    const first = await saveDraft(client);
    const second = await saveDraft(client);

    expect(first.isError).not.toBe(true);
    expect(second.isError).not.toBe(true);
    expect(dataOf(second)).toEqual(dataOf(first));
    // Without the replay the second call would fail the revision check instead of
    // answering, and with a released key it would stack a second version.
    expect((await versionsOf(definitionId)).map((row) => row.version)).toEqual([1]);
  });

  it("answers NOT_FOUND for a definition that does not exist", async () => {
    const client = await connectedClient();

    const result = await saveDraft(client, { definitionId: 987_654 });

    expect(result.isError).toBe(true);
    expect(errorPayload(result).code).toBe("NOT_FOUND");
    expect(await auditedErrorCodes()).toEqual(["NOT_FOUND"]);
  });
});

describe("workflows.publish", () => {
  it("deploys the draft as the live head and reports that it is still disabled", async () => {
    await seedDraft(definitionId, 1, graph());
    const client = await connectedClient();

    const result = await publish(client);

    expect(result.isError).not.toBe(true);
    expect(dataOf(result)).toEqual({
      definitionId,
      deployedVersion: 1,
      // Publishing arms the graph a dispatch resolves against; it does not enable
      // the definition, and an agent is told so rather than left to assume it.
      enabled: false,
      triggerTypes: ["trigger_ticket_ai"],
    });
    // The store's own bookkeeping, which is the whole reason this tool calls it:
    // the deployed pointer and the denormalized trigger column move together.
    expect(await definitionRows()).toMatchObject([
      { deployedVersion: 1, triggerTypes: ["trigger_ticket_ai"], enabled: false },
    ]);
    expect(await auditedOutcomes()).toEqual(["attempted", "success"]);
  });

  // The point of the whole slice: publishing goes through the dashboard's own
  // path, so it cannot be the way around the gate that path enforces.
  it("refuses a graph the deployment gate rejects, even though the same graph saves as a draft", async () => {
    const client = await connectedClient();

    // Accepted as a draft, exactly as the dashboard accepts a graph with issues.
    const saved = await saveDraft(client, { definition: reservedIdGraph() });
    expect(saved.isError).not.toBe(true);

    // And refused at publish, by the gate that lives inside
    // deployWorkflowDefinition (store.ts:1150) and nowhere else. If this tool had
    // reimplemented the publish instead of calling the store, this graph would go
    // live with an id the runtime reserves for the trigger input.
    const result = await publish(client, { idempotencyKey: KEY_TWO });

    expect(result.isError).toBe(true);
    expect(errorPayload(result).code).toBe("VALIDATION_FAILED");
    expect(errorPayload(result).message).toContain("reserved for the active trigger input");
    expect(await definitionRows()).toMatchObject([{ deployedVersion: null, triggerTypes: [] }]);
  });

  it("refuses a stale expected deployed version and deploys nothing", async () => {
    await seedDraft(definitionId, 1, graph());
    const client = await connectedClient();

    // The caller thinks version 4 is live; nothing is.
    const result = await publish(client, { expectedDeployedVersion: 4 });

    expect(result.isError).toBe(true);
    expect(errorPayload(result).code).toBe("CONFLICT");
    expect(errorPayload(result).message).toContain("reload before deploying");
    expect(await definitionRows()).toMatchObject([{ deployedVersion: null }]);
    expect(await auditedErrorCodes()).toEqual(["CONFLICT"]);
  });

  it("refuses a definition that has no draft to publish", async () => {
    const client = await connectedClient();

    const result = await publish(client);

    expect(result.isError).toBe(true);
    expect(errorPayload(result).code).toBe("CONFLICT");
    expect(errorPayload(result).message).toContain("Save a draft before deploying");
    expect(await definitionRows()).toMatchObject([{ deployedVersion: null }]);
  });

  it("records the definition and both versions in the audit trail, never the graph", async () => {
    await seedDraft(definitionId, 1, graph());
    const client = await connectedClient();

    await publish(client);

    const rows = await auditRows();
    expect(JSON.stringify(rows)).not.toContain(MARKER);
    for (const row of rows) {
      // Which definition, which draft revision went live, and which deployment it
      // replaced ("none" when there was none).
      expect(row.targetRefs).toEqual([String(definitionId), "1", "none"]);
      expect(row.mutationClass).toBe("direct");
    }
  });
});

// One table for the three tools, because the locks are the same three locks and a
// tool added to this module without them has to fail here.
describe("who may author a workflow", () => {
  const calls: Array<[string, (client: Client) => Promise<ToolResult>]> = [
    ["workflows.create", (client) => create(client)],
    ["workflows.save_draft", (client) => saveDraft(client)],
    ["workflows.publish", (client) => publish(client)],
  ];

  async function nothingChanged(): Promise<void> {
    expect(await definitionRows()).toMatchObject([
      { name: "Seeded workflow", deployedVersion: null },
    ]);
    expect(await versionsOf(definitionId)).toEqual([]);
  }

  for (const [name, call] of calls) {
    it(`refuses a member on ${name}, whose role may not author workflows`, async () => {
      const client = await connectedClient({ role: "member", scopes: WRITE_ONLY });

      const result = await call(client);

      expect(result.isError).toBe(true);
      expect(errorPayload(result).code).toBe("FORBIDDEN");
      await nothingChanged();
      expect(await auditedErrorCodes()).toEqual(["FORBIDDEN"]);
    });

    // The decision this whole scope exists for: consent to read, to fire an
    // existing workflow and even to edit a prompt is not consent to write the
    // workflow the platform will then carry out with its own credentials.
    it(`refuses a token holding every other scope but not workflows:write on ${name}`, async () => {
      const client = await connectedClient({ scopes: EVERY_OTHER_SCOPE });

      const result = await call(client);

      // Distinct from FORBIDDEN on purpose: the fix is a token carrying the write
      // scope, not an owner changing somebody's role.
      expect(result.isError).toBe(true);
      expect(errorPayload(result).code).toBe("INSUFFICIENT_SCOPE");
      await nothingChanged();
      expect(await auditedErrorCodes()).toEqual(["INSUFFICIENT_SCOPE"]);
    });

    // oauth.ts keeps workflows:write out of a client_credentials token, and the
    // role list is the second lock: an unattended automation must not be able to
    // author what the platform runs, whatever its token happens to carry.
    it(`refuses a service client on ${name} even when its token carries workflows:write`, async () => {
      const client = await connectedClient({
        kind: "service",
        role: "service",
        userId: null,
        subject: "client:automation",
        scopes: WRITE_ONLY,
      });

      const result = await call(client);

      expect(result.isError).toBe(true);
      expect(errorPayload(result).code).toBe("FORBIDDEN");
      await nothingChanged();
      expect(await auditedErrorCodes()).toEqual(["FORBIDDEN"]);
    });
  }
});
