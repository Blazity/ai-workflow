import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../env.js", () => ({
  env: {
    MCP_SERVER_VERSION: "0.1.0",
    MCP_MAX_RESULT_BYTES: 65_536,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
    MCP_AUDIT_RETENTION_DAYS: 365,
  },
}));

import type { Adapters } from "../../lib/adapters.js";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import {
  mcpAuditEvents,
  organization,
  promptLibrary,
  promptLibraryVersions,
} from "../../db/schema.js";
import { BUILT_IN_PROMPT_SLUG_BY_NAME } from "../../prompt-library/builtin-prompts.js";
import type { McpActorContext, McpScope } from "../contracts.js";
import { actorFor, depsFor } from "../test-support.js";
import { registerPromptAuthoringTools } from "./prompt-authoring.js";

const ORG_ID = "org-execute";

// Distinctive enough that "the audit row does not contain the prompt body" is a
// real assertion: a marker this shape appears nowhere else in the schema, so a
// passing not.toContain cannot be passing by accident.
const MARKER = "MARKER-9f3c1d";
const SEEDED_BODY = `Approve only what the ticket asked for. ${MARKER}-old`;
const NEW_BODY = `Refuse the ticket unless its acceptance criteria name a rollback plan. ${MARKER}-new`;
const OTHER_BODY = `Ask for a test plan before approving. ${MARKER}-other`;

// The store's ceiling on a body (prompt-library/store.ts:175), restated by the
// catalog so the refusal happens before the call is admitted.
const BODY_MAX_LENGTH = 50_000;

const KEY_ONE = "11111111-1111-4111-8111-111111111111";
const KEY_TWO = "22222222-2222-4222-8222-222222222222";

// A write needs this scope and nothing else: asserting the successful path with
// ONLY prompts:write is what proves the tool is not quietly riding on mcp:read.
const WRITE_ONLY: ReadonlySet<McpScope> = new Set(["prompts:write"]);

let db: Db;
let now: Date;
let promptId: number;
let builtInPromptId: number;

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(organization).values({ id: ORG_ID, name: "Execute", slug: "execute" });
  now = new Date("2026-08-12T12:00:00.000Z");
  promptId = await seedPrompt("team-review-guide", "Team review guide", SEEDED_BODY);
  builtInPromptId = await builtInPrompt();
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function seedPrompt(slug: string, name: string, body: string): Promise<number> {
  const [prompt] = await db
    .insert(promptLibrary)
    .values({ slug, name, createdById: "admin", createdByLabel: "Admin" })
    .returning({ id: promptLibrary.id });
  await db.insert(promptLibraryVersions).values({
    promptId: prompt!.id,
    version: 1,
    body,
    createdById: "admin",
    createdByLabel: "Admin",
  });
  return prompt!.id;
}

/** The platform's own "implement" prompt, seeded by migration 0021 and therefore
 * already in every database built from the committed migrations. Read rather than
 * inserted, and asserted to exist, so the built-in refusal below is exercised
 * against the real seeded row instead of a fixture that only looks like one. */
async function builtInPrompt(): Promise<number> {
  const rows = await db
    .select({ id: promptLibrary.id })
    .from(promptLibrary)
    .where(eq(promptLibrary.slug, BUILT_IN_PROMPT_SLUG_BY_NAME.implement))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("Expected the built-in implement prompt to be seeded");
  return row.id;
}

async function connectedClient(actor: Partial<McpActorContext> = { scopes: WRITE_ONLY }) {
  const server = new McpServer({ name: "prompt-authoring-test", version: "0.1.0" });
  registerPromptAuthoringTools(
    server,
    depsFor(db, () => now, { actor: actorFor(actor), adapters: {} as Adapters }),
  );
  const client = new Client({ name: "prompt-authoring-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(() => client.close(), () => server.close());
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function updateArgs(over: Record<string, unknown> = {}) {
  return {
    promptId,
    expectedVersion: 1,
    body: NEW_BODY,
    idempotencyKey: KEY_ONE,
    ...over,
  };
}

async function update(client: Client, over: Record<string, unknown> = {}): Promise<ToolResult> {
  return client.callTool({ name: "prompts.update", arguments: updateArgs(over) });
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

async function versionsOf(id: number) {
  return db
    .select({
      version: promptLibraryVersions.version,
      body: promptLibraryVersions.body,
      label: promptLibraryVersions.createdByLabel,
    })
    .from(promptLibraryVersions)
    .where(eq(promptLibraryVersions.promptId, id))
    .orderBy(asc(promptLibraryVersions.version));
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

describe("prompts.update", () => {
  it("stores the new body as the next version and names the client that wrote it", async () => {
    const client = await connectedClient();

    const result = await update(client);

    expect(result.isError).not.toBe(true);
    expect(dataOf(result)).toEqual({
      promptId,
      slug: "team-review-guide",
      version: 2,
      changed: true,
      bodyHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    // The reply carries a digest, never the text it just stored: this value is
    // kept as the idempotency key's response and hashed into the audit row.
    expect(JSON.stringify(result.structuredContent)).not.toContain(MARKER);
    expect(await versionsOf(promptId)).toEqual([
      { version: 1, body: SEEDED_BODY, label: "Admin" },
      // The prompt's own history says who edited it, so an operator reading the
      // version list sees the MCP client rather than an anonymous save.
      { version: 2, body: NEW_BODY, label: "MCP client-execute" },
    ]);
    expect(await auditedOutcomes()).toEqual(["attempted", "success"]);
  });

  it("keeps the prompt body out of the audit trail and records the prompt and version instead", async () => {
    const client = await connectedClient();

    await update(client);

    // The body IS in the library (asserted above and again here), so the absence
    // below is the audit row's doing and not the test failing to write anything.
    expect((await versionsOf(promptId)).at(-1)?.body).toBe(NEW_BODY);
    const rows = await auditRows();
    expect(JSON.stringify(rows)).not.toContain(MARKER);
    expect(JSON.stringify(rows)).not.toContain(NEW_BODY);
    for (const row of rows) {
      // Which prompt, and which version the edit replaced. The text survives only
      // as a digest, in the hashes beside it.
      expect(row.targetRefs).toEqual([String(promptId), "1"]);
      expect(row.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(row.mutationClass).toBe("direct");
    }
    expect(rows.map((row) => row.outputHash).filter((hash) => hash !== null)).toHaveLength(1);
  });

  it("refuses a member, whose role may not author prompts", async () => {
    const client = await connectedClient({ role: "member", scopes: WRITE_ONLY });

    const result = await update(client);

    expect(result.isError).toBe(true);
    expect(errorPayload(result).code).toBe("FORBIDDEN");
    expect(await versionsOf(promptId)).toHaveLength(1);
    expect(await auditedErrorCodes()).toEqual(["FORBIDDEN"]);
  });

  // The decision this whole scope exists for: consent to read tickets and to fire
  // runs is not consent to rewrite the instructions those runs are given.
  it("refuses a token holding mcp:read and runs:dispatch but not prompts:write", async () => {
    const client = await connectedClient({
      scopes: new Set(["mcp:read", "runs:dispatch"]),
    });

    const result = await update(client);

    // Distinct from FORBIDDEN on purpose: the fix is a token carrying the write
    // scope, not an owner changing somebody's role.
    expect(result.isError).toBe(true);
    expect(errorPayload(result).code).toBe("INSUFFICIENT_SCOPE");
    expect(await versionsOf(promptId)).toHaveLength(1);
    expect(await auditedErrorCodes()).toEqual(["INSUFFICIENT_SCOPE"]);
  });

  // request-context.ts strips prompts:write out of a service actor's scope set, so
  // this actor cannot arise from a real token; the role list is what refuses the
  // call anyway, and asserting it keeps the second lock from rotting unnoticed.
  it("refuses a service client even when its token carries prompts:write", async () => {
    const client = await connectedClient({
      kind: "service",
      role: "service",
      userId: null,
      subject: "client:automation",
      scopes: WRITE_ONLY,
    });

    const result = await update(client);

    expect(result.isError).toBe(true);
    expect(errorPayload(result).code).toBe("FORBIDDEN");
    expect(await versionsOf(promptId)).toHaveLength(1);
    expect(await auditedErrorCodes()).toEqual(["FORBIDDEN"]);
  });

  it("refuses a built-in platform prompt and writes no version for it", async () => {
    const client = await connectedClient();
    const before = await versionsOf(builtInPromptId);

    const result = await update(client, { promptId: builtInPromptId });

    expect(result.isError).toBe(true);
    expect(errorPayload(result).code).toBe("FORBIDDEN");
    // The message has to name the way this change is actually made, or an agent
    // retries forever: a built-in body moves by resync migration, and an edit
    // here would fail the drift gate or be invisible to runs pinned at version 1.
    expect(errorPayload(result).message).toContain("resync migration");
    expect(await versionsOf(builtInPromptId)).toEqual(before);
    expect(await auditedErrorCodes()).toEqual(["FORBIDDEN"]);
  });

  it("refuses a stale expectedVersion, writes nothing, and leaves the key usable for the corrected edit", async () => {
    const client = await connectedClient();
    // Somebody else saved version 2 while this caller was still holding 1.
    await db.insert(promptLibraryVersions).values({
      promptId,
      version: 2,
      body: OTHER_BODY,
      createdById: "admin",
      createdByLabel: "Admin",
    });

    const stale = await update(client);

    expect(stale.isError).toBe(true);
    expect(errorPayload(stale).code).toBe("CONFLICT");
    expect(errorPayload(stale).message).toContain("is at version 2");
    // Nothing saved: the point of the compare-and-set is that the other writer's
    // text is not silently replaced by an edit made against an older body.
    expect(await versionsOf(promptId)).toHaveLength(2);

    // Refused before the store was reached, so the key is provably unspent and the
    // corrected edit may reuse it rather than being frozen out for a day.
    const corrected = await update(client, { expectedVersion: 2 });

    expect(corrected.isError).not.toBe(true);
    expect(dataOf(corrected)).toMatchObject({ version: 3, changed: true });
    expect((await versionsOf(promptId)).map((row) => row.version)).toEqual([1, 2, 3]);
  });

  it("repeating the same key with the same edit stores exactly one version", async () => {
    const client = await connectedClient();

    const first = await update(client);
    const second = await update(client);

    expect(first.isError).not.toBe(true);
    expect(second.isError).not.toBe(true);
    expect(dataOf(second)).toEqual(dataOf(first));
    // Without the replay the second call would fail the version check instead of
    // answering, and with a released key it would stack a third version.
    expect((await versionsOf(promptId)).map((row) => row.version)).toEqual([1, 2]);
  });

  it("refuses the same key carrying a different edit", async () => {
    const client = await connectedClient();
    await update(client);

    const result = await update(client, { expectedVersion: 2, body: OTHER_BODY });

    expect(result.isError).toBe(true);
    expect(errorPayload(result).code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await versionsOf(promptId)).map((row) => row.version)).toEqual([1, 2]);
  });

  it("refuses a body past the library's ceiling before it costs a slot or a row", async () => {
    const client = await connectedClient();

    // Refused by the catalog schema, which the SDK and the transport gate share,
    // so the call never reaches the handler: no version, and not even an attempt
    // on record. The refusal is the SDK's own validation error rather than this
    // module's error shape, because nothing of ours ran.
    const refused = await update(client, { body: "x".repeat(BODY_MAX_LENGTH + 1) });

    expect(refused.isError).toBe(true);
    const refusalText = (refused.content as Array<{ text: string }>)[0]!.text;
    expect(refusalText).toContain("body");
    expect(refusalText).toContain(String(BODY_MAX_LENGTH));
    expect(await versionsOf(promptId)).toHaveLength(1);
    expect(await auditRows()).toHaveLength(0);

    // And the ceiling is exactly the store's own, so a body the library can hold
    // is not refused by the tool in front of it.
    const accepted = await update(client, { body: "y".repeat(BODY_MAX_LENGTH) });

    expect(accepted.isError).not.toBe(true);
    expect(dataOf(accepted)).toMatchObject({ version: 2 });
  });

  it("stores no second version for a body identical to the one already there", async () => {
    const client = await connectedClient();

    const result = await update(client, { body: SEEDED_BODY });

    expect(result.isError).not.toBe(true);
    // Honest rather than silently successful: the head is unchanged and says so,
    // so an agent does not read version 1 as a failed write.
    expect(dataOf(result)).toMatchObject({ version: 1, changed: false });
    expect(await versionsOf(promptId)).toHaveLength(1);
  });

  it("answers NOT_FOUND for a prompt that does not exist", async () => {
    const client = await connectedClient();

    const result = await update(client, { promptId: 987_654 });

    expect(result.isError).toBe(true);
    expect(errorPayload(result).code).toBe("NOT_FOUND");
    expect(await auditedErrorCodes()).toEqual(["NOT_FOUND"]);
  });

  it("answers CONFLICT for an archived prompt", async () => {
    await db
      .update(promptLibrary)
      .set({ archivedAt: new Date("2026-08-01T00:00:00.000Z") })
      .where(eq(promptLibrary.id, promptId));
    const client = await connectedClient();

    const result = await update(client);

    expect(result.isError).toBe(true);
    expect(errorPayload(result).code).toBe("CONFLICT");
    expect(errorPayload(result).message).toContain("archived");
    expect(await versionsOf(promptId)).toHaveLength(1);
  });
});
