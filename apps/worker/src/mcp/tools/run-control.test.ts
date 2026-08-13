import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../env.js", () => ({
  env: {
    MCP_SERVER_VERSION: "0.1.0",
    DASHBOARD_ORIGIN: "https://dashboard.example",
    MCP_MAX_RESULT_BYTES: 65_536,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
    MCP_AUDIT_RETENTION_DAYS: 365,
  },
}));

const hooks = vi.hoisted(() => ({
  resumeHook: vi.fn(),
  getHookByToken: vi.fn(),
}));

vi.mock("workflow/api", () => ({
  resumeHook: (...args: unknown[]) => hooks.resumeHook(...args),
  getHookByToken: (...args: unknown[]) => hooks.getHookByToken(...args),
}));

import { MAX_ANSWER_LENGTH } from "../../clarifications/answer-core.js";
import {
  getHookClarification,
  prepareHookClarification,
  publishHookClarification,
} from "../../clarifications/hook-store.js";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import { activeRuns, organization, workflowRuns } from "../../db/schema.js";
import type { Adapters } from "../../lib/adapters.js";
import { MCP_TOOL_CATALOG } from "../tool-catalog.js";
import { policyFor } from "../policy.js";
import type { McpActorContext, McpScope } from "../contracts.js";
import { actorFor, depsFor } from "../test-support.js";
import { registerRunControlTools } from "./run-control.js";

const ORG_ID = "org-execute";
const RUN_ID = "wrun_parked";
const TICKET = "AWT-1";
const SUBJECT = `ticket:jira:${TICKET}`;

const KEY_ONE = "11111111-1111-4111-8111-111111111111";
const KEY_TWO = "22222222-2222-4222-8222-222222222222";

// Answering rides the dispatch scope and nothing else, so asserting the happy path
// with ONLY this scope is what proves the tool is not quietly riding on mcp:read.
const DISPATCH_ONLY: ReadonlySet<McpScope> = new Set(["runs:dispatch"]);
const READ_ONLY: ReadonlySet<McpScope> = new Set(["mcp:read"]);

const fetchTicket = vi.fn();

let db: Db;
let now: Date;
let clarificationId: string;
let hookToken: string;

beforeEach(async () => {
  db = await createTestDb();
  now = new Date("2026-08-13T12:00:00.000Z");
  await db.insert(organization).values({ id: ORG_ID, name: "Execute", slug: "execute" });
  hooks.resumeHook.mockReset();
  hooks.getHookByToken.mockReset();
  hooks.resumeHook.mockResolvedValue({ runId: RUN_ID });
  // The default for a delivered resume: the hook is consumed, so a later lookup fails.
  hooks.getHookByToken.mockRejectedValue(new Error("hook consumed"));
  fetchTicket.mockReset();
  fetchTicket.mockResolvedValue({ identifier: TICKET, trackerStatus: "Do zrobienia" });
  const seeded = await seedParkedRun();
  clarificationId = seeded.id;
  hookToken = seeded.hookToken;
}, 30_000);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** A run suspended on a clarification hook: the published row, the bound subject
 *  claim the resumable lookup requires, and the park marker the answer clears. */
async function seedParkedRun() {
  const row = await prepareHookClarification(db, {
    ticketKey: TICKET,
    subjectKey: SUBJECT,
    runId: RUN_ID,
    blockId: "prepare_workspace",
    definitionId: 1,
    definitionVersion: 4,
    questions: ["Which repository should this ticket be implemented in?"],
    suggestedAnswers: ["acme/web", "acme/api"],
  });
  await db.insert(activeRuns).values({
    subjectKey: SUBJECT,
    ticketKey: TICKET,
    ownerToken: "owner-1",
    runId: RUN_ID,
    state: "bound",
    runKind: "ticket",
  });
  await db.insert(workflowRuns).values({
    runId: RUN_ID,
    subjectKey: SUBJECT,
    ticketKey: TICKET,
    status: "awaiting",
  });
  return publishHookClarification(db, row.id);
}

async function connectedClient(
  actor: Partial<McpActorContext> = { scopes: DISPATCH_ONLY },
) {
  const server = new McpServer({ name: "run-control-test", version: "0.1.0" });
  registerRunControlTools(
    server,
    depsFor(db, () => now, {
      actor: actorFor(actor),
      adapters: { issueTracker: { fetchTicket } } as unknown as Adapters,
    }),
  );
  const client = new Client({ name: "run-control-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(() => client.close(), () => server.close());
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

async function answer(client: Client, over: Record<string, unknown> = {}): Promise<ToolResult> {
  return client.callTool({
    name: "runs.answer_clarification",
    arguments: { runId: RUN_ID, answer: "acme/web", idempotencyKey: KEY_ONE, ...over },
  });
}

function errorPayload(result: ToolResult): {
  code: string;
  message: string;
  retryable: boolean;
} {
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  return (
    JSON.parse(text) as { error: { code: string; message: string; retryable: boolean } }
  ).error;
}

function dataOf(result: ToolResult): Record<string, unknown> {
  return (result.structuredContent as { data: Record<string, unknown> }).data;
}

const runStatus = () =>
  db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.runId, RUN_ID))
    .then((rows) => rows[0]?.status);

describe("runs.get_clarification", () => {
  it("returns the question a parked run is waiting on", async () => {
    const client = await connectedClient({ scopes: READ_ONLY });

    const result = await client.callTool({
      name: "runs.get_clarification",
      arguments: { runId: RUN_ID },
    });

    expect(dataOf(result)).toEqual({
      runId: RUN_ID,
      clarification: {
        clarificationId,
        status: "pending",
        blockId: "prepare_workspace",
        questions: ["Which repository should this ticket be implemented in?"],
        suggestedAnswers: ["acme/web", "acme/api"],
        askedAt: expect.any(String),
        // The store stamps a resumability deadline on every published question, and
        // the reader carries it: after it passes the ticket starts over from scratch,
        // which an agent deciding whether to answer or to give up has to know.
        expiresAt: expect.any(String),
        ticketKey: TICKET,
        answerable: true,
      },
    });
  });

  it("separates a run that is not waiting from a run that does not exist", async () => {
    await db.insert(workflowRuns).values({
      runId: "wrun_busy",
      subjectKey: "ticket:jira:AWT-2",
      ticketKey: "AWT-2",
      status: "running",
    });
    const client = await connectedClient({ scopes: READ_ONLY });

    const live = await client.callTool({
      name: "runs.get_clarification",
      arguments: { runId: "wrun_busy" },
    });
    expect(dataOf(live)).toEqual({ runId: "wrun_busy", clarification: null });

    // A typo'd run id must not read as "this run is not waiting", which is the
    // answer an agent would act on by moving somewhere else entirely.
    const unknown = await client.callTool({
      name: "runs.get_clarification",
      arguments: { runId: "wrun_nope" },
    });
    expect(errorPayload(unknown).code).toBe("NOT_FOUND");
  });
});

describe("runs.answer_clarification", () => {
  it("delivers the answer through the shared core and resumes the same run", async () => {
    const client = await connectedClient();

    const result = await answer(client);

    expect(dataOf(result)).toMatchObject({
      clarificationId,
      runId: RUN_ID,
      status: "answered",
      ticketKey: TICKET,
      answeredByLabel: "MCP client-execute",
    });
    // The core's own resume, with the MCP client named as the answerer so the
    // resumed agent and the ticket show who answered.
    expect(hooks.resumeHook).toHaveBeenCalledWith(
      hookToken,
      expect.objectContaining({
        answer: "acme/web",
        answeredByLabel: "MCP client-execute",
      }),
    );
    expect((await getHookClarification(db, clarificationId))?.status).toBe("answered");
    // The park marker is cleared by the core, so the run stops reading as awaiting
    // the moment the answer lands.
    expect(await runStatus()).toBe("running");
  });

  it("admits a member, which is the dashboard's own decision for this action", async () => {
    const client = await connectedClient({ role: "member", scopes: DISPATCH_ONLY });

    expect(dataOf(await answer(client))).toMatchObject({ status: "answered" });
  });

  it("refuses a token with nobody behind it", async () => {
    const client = await connectedClient({
      role: "service",
      kind: "service",
      userId: null,
      scopes: DISPATCH_ONLY,
    });

    const result = await answer(client);

    // The invariant: a run parks on a clarification precisely when it needs a human
    // decision, so a client-credentials token must not be able to satisfy it.
    expect(errorPayload(result).code).toBe("FORBIDDEN");
    expect(hooks.resumeHook).not.toHaveBeenCalled();
    expect((await getHookClarification(db, clarificationId))?.status).toBe("pending");
    // The role list is the ONLY lock on that invariant, because withoutAuthoringScopes
    // never takes runs:dispatch away from a service actor. This asserts the difference
    // from the dispatch policy directly, so opening the list cannot pass silently.
    expect(policyFor("runs.answer_clarification").roles).not.toContain("service");
    expect(policyFor("workflows.dispatch").roles).toContain("service");
  });

  it("replays an identical retry instead of resuming twice", async () => {
    const client = await connectedClient();
    const first = await answer(client);

    const second = await answer(client);

    expect(dataOf(second)).toEqual(dataOf(first));
    expect(hooks.resumeHook).toHaveBeenCalledTimes(1);
  });

  it("refuses the same key carrying a different answer", async () => {
    const client = await connectedClient();
    await answer(client);

    const changed = await answer(client, { answer: "acme/api" });

    expect(errorPayload(changed).code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("reports a question that another channel already answered", async () => {
    const client = await connectedClient();
    await answer(client);

    // A different key, so the idempotency store lets it through to the core, whose
    // compare-and-set is what actually refuses the second answer.
    const late = await answer(client, { answer: "acme/api", idempotencyKey: KEY_TWO });

    expect(errorPayload(late)).toMatchObject({ code: "CONFLICT", retryable: false });
    expect(hooks.resumeHook).toHaveBeenCalledTimes(1);
  });

  it("refuses an answer bound to a question the run is not waiting on", async () => {
    const client = await connectedClient();

    const result = await answer(client, { clarificationId: "cl_stale" });

    const error = errorPayload(result);
    expect(error.code).toBe("VALIDATION_FAILED");
    // Names the id the run IS waiting on, so the caller can recover in one read
    // rather than guessing.
    expect(error.message).toContain(clarificationId);
    expect(hooks.resumeHook).not.toHaveBeenCalled();
  });

  it("refuses a run that is not parked on anything", async () => {
    await db.insert(workflowRuns).values({
      runId: "wrun_busy",
      subjectKey: "ticket:jira:AWT-2",
      ticketKey: "AWT-2",
      status: "running",
    });
    const client = await connectedClient();

    const result = await answer(client, { runId: "wrun_busy" });

    expect(errorPayload(result).code).toBe("CONFLICT");
    expect(hooks.resumeHook).not.toHaveBeenCalled();
  });

  it("keeps the answer bound to the core's own length rule", () => {
    // The catalog restates the bound because it must not import the core (the
    // transport gate loads the catalog on the request path). This is the lock that
    // makes the duplication safe.
    const schema = MCP_TOOL_CATALOG["runs.answer_clarification"].inputSchema;
    expect(schema.safeParse({
      runId: RUN_ID,
      answer: "x".repeat(MAX_ANSWER_LENGTH),
      idempotencyKey: KEY_ONE,
    }).success).toBe(true);
    expect(schema.safeParse({
      runId: RUN_ID,
      answer: "x".repeat(MAX_ANSWER_LENGTH + 1),
      idempotencyKey: KEY_ONE,
    }).success).toBe(false);
  });
});
