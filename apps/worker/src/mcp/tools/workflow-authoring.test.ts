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
// The schedule reader, so the "the liveness check itself failed" branch can be
// reached: everything else in this module runs against the real store, and the
// default implementation below is the real one.
const probe = vi.hoisted(() => ({ scheduleReadFails: false }));
vi.mock("../../schedule-trigger/schedule-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../schedule-trigger/schedule-store.js")>();
  return {
    ...actual,
    listSchedulesForDefinition: async (
      ...args: Parameters<typeof actual.listSchedulesForDefinition>
    ) => {
      if (probe.scheduleReadFails) throw new Error("neon: connection reset");
      return actual.listSchedulesForDefinition(...args);
    },
  };
});

vi.mock("../../../env.js", () => ({
  env: {
    MCP_SERVER_VERSION: "0.1.0",
    DASHBOARD_ORIGIN: "https://dashboard.example",
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

import type { MessagingAdapter, TicketEvent } from "../../adapters/messaging/types.js";
import type { Adapters } from "../../lib/adapters.js";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import {
  mcpAuditEvents,
  organization,
  workflowDefinitions,
  workflowDefinitionVersions,
  workflowSchedules,
} from "../../db/schema.js";
import type { McpActorContext, McpScope } from "../contracts.js";
import { actorFor, depsFor } from "../test-support.js";
import { WORKFLOW_MAX_EDGES, WORKFLOW_MAX_NODES } from "../tool-catalog.js";
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

// The platform's own definition, seeded ENABLED by migration 0013 and holding the
// trigger_ticket_ai binding since 0016. Publishing into it is the case this file
// missed: a real ticket entering the AI column executes whatever its deployed
// version says, so a publish there is not authoring, it is a change to production.
const PLATFORM_DEFINITION_NAME = "Ticket workflow";

// Read directly by lib/repo-allowlist.ts (not through the mocked env module), which
// is why these tests set the variable itself. Unset means "no allowlist", where by
// the platform's own fail-open default nothing is outside one.
const ORIGINAL_ALLOWED_REPOS = process.env.AGENT_ALLOWED_REPOS;
const ALLOWED_REPO = "acme/allowed-service";
const OUTSIDE_REPO = "acme/private-infrastructure";

// Substituted for the real Slack adapter. Typed off the adapter's own interface, so
// a signature change here is a compile error rather than a test that keeps asserting
// against a call nobody makes any more.
const notifyForTicket = vi.fn<MessagingAdapter["notifyForTicket"]>();

// A name an agent could pick after reading a ticket it does not trust: a Slack link
// whose label claims something the platform never said, a mention, a second line
// that reads like our own copy, and enough words to run past the label ceiling.
const HOSTILE_NAME = `Ship <https://attacker.example|approved by platform>\n<@U123> ${"deploy ".repeat(10)}now`;

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
  notifyForTicket.mockReset();
  notifyForTicket.mockResolvedValue(undefined);
  probe.scheduleReadFails = false;
  delete process.env.AGENT_ALLOWED_REPOS;
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  if (ORIGINAL_ALLOWED_REPOS === undefined) delete process.env.AGENT_ALLOWED_REPOS;
  else process.env.AGENT_ALLOWED_REPOS = ORIGINAL_ALLOWED_REPOS;
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
    depsFor(db, () => now, {
      actor: actorFor(actor),
      adapters: { messaging: { notifyForTicket } } as unknown as Adapters,
    }),
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

/** The one announcement this call sent, with the two things about it that are not
 *  its text asserted here so every caller below can read only the copy: it travels
 *  under a subject that is not a ticket key, so it can never thread itself under an
 *  unrelated run's status line, and it is a plain note rather than a ticket status. */
function announcement(): string {
  expect(notifyForTicket).toHaveBeenCalledOnce();
  const [subject, event] = notifyForTicket.mock.calls[0]!;
  expect(subject).toBe("mcp-authoring");
  expect(event.kind).toBe("note");
  return (event as Extract<TicketEvent, { kind: "note" }>).text;
}

/** The seeded platform definition, read rather than inserted and asserted to be
 *  enabled, so the publish below is exercised against the row real tickets route to
 *  instead of a fixture that only looks like one. */
async function platformDefinition(): Promise<{ id: number; enabled: boolean }> {
  const rows = await db
    .select({ id: workflowDefinitions.id, enabled: workflowDefinitions.enabled })
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.name, PLATFORM_DEFINITION_NAME))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`Expected the seeded "${PLATFORM_DEFINITION_NAME}" definition`);
  expect(row.enabled).toBe(true);
  return row;
}

/** The same minimal graph, pinning one repository to the definition. A pin is the
 *  one thing a workflow can carry that WIDENS what the platform may clone and open
 *  pull requests on (lib/repo-allowlist.ts:89-103). */
function pinnedGraph(repoPath: string) {
  return graph({
    repositoryScope: { repositories: [{ provider: "github", repoPath }] },
  });
}

const SCHEDULE_NODE_ID = "nightly";

/** A graph whose only trigger is a schedule, configured well enough to deploy. A
 *  schedule is the trigger whose ability to fire lives entirely outside the
 *  definition row: the evaluator reads workflow_schedules and skips a paused or
 *  revoked row, and a deploy deliberately does not lift a pause
 *  (store.ts:1003-1004). */
function scheduleGraph() {
  return graph({
    nodes: [
      {
        id: SCHEDULE_NODE_ID,
        type: "trigger_schedule",
        name: `Nightly trigger ${MARKER}`,
        x: 10,
        y: 20,
        configuration: {
          cron: "0 3 * * *",
          timezone: "UTC",
          taskTitle: "Nightly sweep",
          taskDescription: "Sweep the backlog every night.",
        },
        inputs: {},
        additionalInputs: [],
      },
    ],
  });
}

/** The workflow name as it survived into the announcement, read back out of the
 *  quotes it is composed into, so an assertion about the LABEL cannot be satisfied
 *  or broken by the message's own deep link (which is legitimately `<url|label>`). */
function announcedName(text: string): string {
  const match = /workflow "([^"]*)"/.exec(text);
  if (!match) throw new Error(`No workflow label in announcement: ${text}`);
  return match[1]!;
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
      // This graph pins nothing, and no allowlist is configured either.
      repositoriesOutsideAllowlist: [],
    });
    // A draft is inert, so nobody is told about one: the channel hears about the
    // publish that makes a graph the platform's instruction, not about the writing.
    expect(notifyForTicket).not.toHaveBeenCalled();
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
      // Which definition, which revision the save replaced, and how many pinned
      // repositories reach past the allowlist. The graph survives only as a digest,
      // in the hashes beside it.
      expect(row.targetRefs).toEqual([String(definitionId), "0", "repos_outside_allowlist:0"]);
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

  // The counterpart of the prompt body ceiling (prompt-authoring.test.ts), and worth
  // its own test because the catalog admits a graph by SIZE and nothing else: this is
  // the only gate in front of save_draft that a graph can fail without the handler
  // ever running. What that means is asserted rather than assumed: no version, and
  // unlike every other refusal in this file NOT EVEN an audit row, because the call
  // was refused by the schema the SDK and the transport gate share before the execute
  // wrapper could record an attempt. The refusal is therefore the SDK's own
  // validation error rather than this module's error shape.
  //
  // The ceilings come from the catalog itself, whose equality with the definition
  // schema's own MAX_NODES/MAX_EDGES is pinned in tool-catalog.test.ts, so a graph the
  // store would accept cannot be refused here.
  it.each([
    [
      "nodes",
      WORKFLOW_MAX_NODES,
      () => graph({ nodes: Array.from({ length: WORKFLOW_MAX_NODES + 1 }, () => ({})) }),
    ],
    [
      "edges",
      WORKFLOW_MAX_EDGES,
      () => graph({ edges: Array.from({ length: WORKFLOW_MAX_EDGES + 1 }, () => ({})) }),
    ],
  ])("refuses a graph past the %s ceiling before it costs a slot or a row", async (
    field,
    ceiling,
    oversized,
  ) => {
    const client = await connectedClient();

    const result = await saveDraft(client, { definition: oversized() });

    expect(result.isError).toBe(true);
    const refusalText = (result.content as Array<{ text: string }>)[0]!.text;
    // "Array must contain at most 200 element(s) at definition.nodes": the field
    // comes from the path and the number from the bound, so neither assertion can
    // pass on an echo of the graph, and nothing of the graph is echoed.
    expect(refusalText).toContain(field);
    expect(refusalText).toContain(String(ceiling));
    expect(await versionsOf(definitionId)).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
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
      replacedVersion: null,
      graphHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      // Inherited from the definition, which this fixture never enabled. Publishing
      // does not flip the switch either way, so the graph just deployed is what a
      // manual dispatch resolves and nothing else.
      enabled: false,
      triggerTypes: ["trigger_ticket_ai"],
      liveOnRealEvents: false,
      // Disabled, so the trigger cannot fire, and the node is named rather than
      // left to be inferred from `enabled`.
      dormantTriggerNodeIds: [TRIGGER_NODE_ID],
      repositoriesOutsideAllowlist: [],
    });
    // Announced even here: an operator finds out that the definition now carries a
    // graph nobody in the dashboard wrote, and the copy says what it does and does
    // not mean.
    expect(announcement()).toContain(
      "The definition is disabled, so only a manual dispatch runs this graph.",
    );
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

    // Raised from INSIDE the operation, under the lease, and provably before
    // anything was deployed, so the lease goes back and the corrected publish may
    // reuse the key. Without that release a caller that mis-stated one number would
    // be frozen out of that key for the rest of its life.
    const corrected = await publish(client, { expectedDeployedVersion: null });

    expect(corrected.isError).not.toBe(true);
    expect(dataOf(corrected)).toMatchObject({ deployedVersion: 1 });
    expect(await definitionRows()).toMatchObject([{ deployedVersion: 1 }]);
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
    // Which definition, which draft revision went live, and which deployment it
    // replaced ("none" when there was none). The attempt is recorded before
    // anything has been read, so those three arrive from the arguments alone.
    const argumentRefs = [String(definitionId), "1", "none"];
    expect(rows.find((row) => row.outcome === "attempted")?.targetRefs).toEqual(argumentRefs);
    // And the count of pinned repositories past the allowlist rides the row that
    // records the deployment, because it is read off the graph that went live.
    expect(rows.find((row) => row.outcome === "success")?.targetRefs).toEqual([
      ...argumentRefs,
      "repos_outside_allowlist:0",
    ]);
    for (const row of rows) expect(row.mutationClass).toBe("direct");
  });

  // The case this file used to miss entirely, and the reason the header's old claim
  // that "an agent cannot arm a workflow against real events" was false: publish
  // takes any definitionId, and the enabled one real tickets route to is a legal
  // argument. Nothing here refuses it; what changed is that the reply and the
  // channel say what just happened.
  it("publishes into a definition an operator already enabled and reports that real events now run it", async () => {
    const platform = await platformDefinition();
    const client = await connectedClient();

    const saved = await saveDraft(client, { definitionId: platform.id });
    expect(saved.isError).not.toBe(true);

    const result = await publish(client, {
      definitionId: platform.id,
      idempotencyKey: KEY_TWO,
    });

    expect(result.isError).not.toBe(true);
    expect(dataOf(result)).toEqual({
      definitionId: platform.id,
      deployedVersion: 1,
      replacedVersion: null,
      graphHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      // True, and inherited: the operator enabled this definition long before the
      // agent existed, and the publish it just accepted is now what its triggers run.
      enabled: true,
      triggerTypes: ["trigger_ticket_ai"],
      // Verified, not deduced: this trigger routes through the binding table, and
      // the deploy that succeeded is what claimed it for an enabled definition.
      liveOnRealEvents: true,
      dormantTriggerNodeIds: [],
      repositoriesOutsideAllowlist: [],
    });
    // The store's own bookkeeping: the enabled definition's live head moved, so the
    // next real ticket resolves this graph (store.ts:605-612).
    const [row] = await db
      .select({
        deployedVersion: workflowDefinitions.deployedVersion,
        enabled: workflowDefinitions.enabled,
      })
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, platform.id));
    expect(row).toEqual({ deployedVersion: 1, enabled: true });
    expect(announcement()).toContain(
      "The definition is ENABLED, so real events (trigger_ticket_ai) now run this graph.",
    );
  });

  // Nothing is taken away: the pin publishes. What it must not do is publish
  // silently, because a pinned repository is the one way a graph can widen the
  // operator's own allowlist, and the deployment gate checks a graph's shape rather
  // than this permission.
  it("publishes a graph pinning a repository outside the allowlist and signals it in the reply, the audit row and the channel", async () => {
    process.env.AGENT_ALLOWED_REPOS = ALLOWED_REPO;
    const client = await connectedClient();

    const saved = await saveDraft(client, { definition: pinnedGraph(OUTSIDE_REPO) });

    expect(saved.isError).not.toBe(true);
    expect(dataOf(saved)).toMatchObject({
      draftRevision: 1,
      repositoriesOutsideAllowlist: [`github:${OUTSIDE_REPO}`],
    });

    const published = await publish(client, { idempotencyKey: KEY_TWO });

    expect(published.isError).not.toBe(true);
    expect(dataOf(published)).toMatchObject({
      deployedVersion: 1,
      repositoriesOutsideAllowlist: [`github:${OUTSIDE_REPO}`],
    });
    // A flag and a count in the audit row, never the paths: those are answered once,
    // in the reply, and these rows are kept for a year.
    const refs = (await auditRows()).map((row) => row.targetRefs);
    expect(refs).toContainEqual([String(definitionId), "0", "repos_outside_allowlist:1"]);
    expect(refs).toContainEqual([String(definitionId), "1", "none", "repos_outside_allowlist:1"]);
    expect(JSON.stringify(await auditRows())).not.toContain(OUTSIDE_REPO);
    // The channel is where a person reads it, so the channel gets the PATH: a count
    // tells an operator to go looking, a path tells them what to look at.
    expect(announcement()).toContain(
      `It pins a repository outside AGENT_ALLOWED_REPOS: github:${OUTSIDE_REPO}.`,
    );
  });

  it("reports nothing outside the allowlist for a pin the operator did allow", async () => {
    process.env.AGENT_ALLOWED_REPOS = `${ALLOWED_REPO},${OUTSIDE_REPO}`;
    const client = await connectedClient();

    const saved = await saveDraft(client, { definition: pinnedGraph(OUTSIDE_REPO) });

    // Same graph as the test above, and now the pin grants nothing the allowlist did
    // not already grant, so the warning has to be absent rather than constant.
    expect(dataOf(saved)).toMatchObject({ repositoriesOutsideAllowlist: [] });
    expect((await auditRows()).map((row) => row.targetRefs)).toContainEqual([
      String(definitionId),
      "0",
      "repos_outside_allowlist:0",
    ]);
  });

  // The announcement is the accountability half of a publish, and it is best-effort
  // on purpose: it runs AFTER the deployment landed, so a Slack outage must not
  // hand the caller an error that reads as "nothing was deployed" and must not buy a
  // second deployment out of the retry that answer would provoke.
  it("keeps a published deployment and its answer when the announcement fails", async () => {
    await seedDraft(definitionId, 1, graph());
    notifyForTicket.mockRejectedValue(new Error("slack is down"));
    const client = await connectedClient();

    const result = await publish(client);

    expect(result.isError).not.toBe(true);
    expect(dataOf(result)).toMatchObject({ deployedVersion: 1, liveOnRealEvents: false });
    expect(await definitionRows()).toMatchObject([{ deployedVersion: 1 }]);
    expect(await auditedOutcomes()).toEqual(["attempted", "success"]);
    // One deployment, not two: the failure is swallowed where it happens rather than
    // turning into a retry.
    expect((await versionsOf(definitionId)).map((version) => version.version)).toEqual([1]);
  });

  it("keeps the graph out of the announcement and links the editor instead", async () => {
    await seedDraft(definitionId, 1, graph());
    const client = await connectedClient();

    await publish(client);

    // The graph IS stored under that marker, so the absence here is the
    // announcement's doing and not the test asserting against nothing.
    expect(JSON.stringify((await versionsOf(definitionId))[0]!.definition)).toContain(MARKER);
    const text = announcement();
    expect(text).not.toContain(MARKER);
    // And what it does carry: who, which definition, which version, and where to go
    // and look, since the message deliberately carries none of the content.
    expect(text).toContain("MCP client client-execute (user:execute)");
    expect(text).toContain(`(definition ${definitionId}) as version 1`);
    expect(text).toContain(
      `<https://dashboard.example/editor?definition=${definitionId}|open in the editor>`,
    );
    // Seeded by "Admin" rather than by this client, so the draft's author is named:
    // the confusing case is one client composing a graph and another publishing it.
    expect(text).toContain("The graph was drafted by Admin.");
  });

  // A publish is the one message an operator is meant to trust, and the workflow
  // name inside it is text an agent chose: the catalog bounds its LENGTH and nothing
  // else, and the adapter's own defanging only touches broadcast tokens, so without
  // a sanitizer at the interpolation site a name can forge a clickable link, a
  // mention, or a second line that reads like the platform's own copy.
  it("strips Slack markup out of a hostile workflow name without breaking its own link", async () => {
    const client = await connectedClient();
    const created = await create(client, { name: HOSTILE_NAME });
    const hostileId = dataOf(created).definitionId as number;
    await saveDraft(client, { definitionId: hostileId, idempotencyKey: KEY_TWO });

    const result = await publish(client, {
      definitionId: hostileId,
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
    });

    expect(result.isError).not.toBe(true);
    const text = announcement();
    const label = announcedName(text);
    // No markup left in the label: not a link, not a mention, not a second line.
    expect(label).not.toMatch(/[<>|]/);
    expect(text).not.toContain("<@U123>");
    expect(text).not.toContain("<https://attacker.example");
    expect(text).not.toMatch(/\n/);
    // Cut to the label ceiling, so a 200-character name cannot push the facts of the
    // announcement off the readable part of the line.
    expect(label.length).toBeLessThanOrEqual(80);
    expect(label.endsWith("…")).toBe(true);
    // And the message's OWN link still works, which is why the sanitizer lives at the
    // interpolation site rather than over the whole string.
    expect(text).toContain(
      `<https://dashboard.example/editor?definition=${hostileId}|open in the editor>`,
    );
    // The name the definition carries is untouched: this is about what a message
    // renders, not about rewriting somebody's data.
    expect((await definitionRows()).map((row) => row.name)).toContain(HOSTILE_NAME);
  });

  // liveOnRealEvents used to be `enabled` under a more impressive name, and every
  // deployable graph has a trigger, so it was `enabled` exactly. This is the case
  // that proves the difference, and it is the one that matters most to an operator:
  // they paused a schedule on purpose, the pause deliberately survives a redeploy,
  // and a publish that claimed "real events now run this graph" would be telling
  // them their pause had been overridden.
  it("reports an enabled definition as not live when its only trigger is a paused schedule", async () => {
    const platform = await platformDefinition();
    const client = await connectedClient();
    await saveDraft(client, { definitionId: platform.id, definition: scheduleGraph() });
    // The first publish mints the schedule row, unpaused, so the graph really is live.
    const live = await publish(client, { definitionId: platform.id, idempotencyKey: KEY_TWO });
    expect(dataOf(live)).toMatchObject({ liveOnRealEvents: true, dormantTriggerNodeIds: [] });
    // Then a person pauses it, which is the state the next publish has to respect.
    await db
      .update(workflowSchedules)
      .set({ pausedAt: new Date("2026-08-12T10:00:00.000Z") })
      .where(eq(workflowSchedules.definitionId, platform.id));
    notifyForTicket.mockClear();

    const result = await publish(client, {
      definitionId: platform.id,
      expectedDeployedVersion: 1,
      idempotencyKey: "44444444-4444-4444-8444-444444444444",
    });

    expect(result.isError).not.toBe(true);
    expect(dataOf(result)).toMatchObject({
      enabled: true,
      triggerTypes: ["trigger_schedule"],
      liveOnRealEvents: false,
      dormantTriggerNodeIds: [SCHEDULE_NODE_ID],
    });
    // The pause survived the deploy, which is why the reply may not claim otherwise.
    const [schedule] = await db
      .select({ pausedAt: workflowSchedules.pausedAt })
      .from(workflowSchedules)
      .where(eq(workflowSchedules.definitionId, platform.id));
    expect(schedule?.pausedAt).not.toBeNull();
    const text = announcement();
    expect(text).toContain(
      "The definition is enabled, but no trigger of this graph was verified able to fire.",
    );
    expect(text).toContain(SCHEDULE_NODE_ID);
  });

  // The check runs after the deployment has landed, so its own failure must not be
  // reported as the failure of the publish. Unverified is the honest answer, and it
  // is the direction that does not over-claim.
  it("reports triggers as unverified rather than failing when the liveness check cannot run", async () => {
    const platform = await platformDefinition();
    const client = await connectedClient();
    await saveDraft(client, { definitionId: platform.id, definition: scheduleGraph() });
    probe.scheduleReadFails = true;

    const result = await publish(client, {
      definitionId: platform.id,
      idempotencyKey: KEY_TWO,
    });

    expect(result.isError).not.toBe(true);
    expect(dataOf(result)).toMatchObject({
      deployedVersion: 1,
      liveOnRealEvents: false,
      dormantTriggerNodeIds: [SCHEDULE_NODE_ID],
    });
    // The deployment is real and is recorded as a success, because it is one.
    const [row] = await db
      .select({ deployedVersion: workflowDefinitions.deployedVersion })
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, platform.id));
    expect(row).toEqual({ deployedVersion: 1 });
    expect(await auditedOutcomes()).toEqual([
      "attempted",
      "attempted",
      "success",
      "success",
    ]);
  });

  // A revision number is not content identity: an agent resuming a plan can publish
  // revision 5 believing it is publishing its own graph. The digest is what lets it
  // check, and it only means anything if both tools hash the same bytes.
  it("reports the digest of the stored graph, matching the one the draft save reported", async () => {
    const client = await connectedClient();

    const saved = await saveDraft(client);
    const published = await publish(client, { idempotencyKey: KEY_TWO });

    expect(dataOf(saved).graphHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(dataOf(published).graphHash).toBe(dataOf(saved).graphHash);
  });

  // A republish of the version already live passes the compare-and-set and does real
  // work (it re-claims the bindings and re-syncs the schedules), so it is announced;
  // what it must not say is "as version 1, replacing version 1", which reads like a
  // bug in the message rather than the no-op it is.
  it("names a republish of the live version as one", async () => {
    await seedDraft(definitionId, 1, graph());
    const client = await connectedClient();
    await publish(client);
    notifyForTicket.mockClear();

    const again = await publish(client, {
      expectedDeployedVersion: 1,
      idempotencyKey: KEY_TWO,
    });

    expect(again.isError).not.toBe(true);
    expect(dataOf(again)).toMatchObject({ deployedVersion: 1, replacedVersion: 1 });
    const text = announcement();
    expect(text).toContain("re-deployed version 1");
    expect(text).toContain("without changing which version is live");
    // And no rollback offer, because there is no other version to roll back to.
    expect(text).not.toContain("roll back");
  });

  it("keeps the graph out of the announcement", async () => {
    await seedDraft(definitionId, 1, graph());
    const client = await connectedClient();

    await publish(client);

    expect(announcement()).not.toContain(MARKER);
  });

  // The announcement is best-effort in both directions a chat backend can fail. A
  // hang is the one that matters most here, because it is the shape that would push
  // a completed deployment past the wrapper's deadline and answer TIMEOUT about it.
  it("answers a publish whose announcement never settles, and not as a timeout", async () => {
    await seedDraft(definitionId, 1, graph());
    notifyForTicket.mockReturnValue(new Promise<void>(() => {}));
    const client = await connectedClient();

    const result = await publish(client);

    expect(result.isError).not.toBe(true);
    expect(dataOf(result)).toMatchObject({ deployedVersion: 1 });
    expect(await auditedOutcomes()).toEqual(["attempted", "success"]);
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

    // request-context.ts keeps workflows:write out of a service actor's scope set,
    // and the role list is the second lock: an unattended automation must not be
    // able to author what the platform runs, whatever its token happens to carry.
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
