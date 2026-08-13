import {
  createServer,
  request as requestHttp,
  type IncomingMessage,
} from "node:http";
import { once } from "node:events";

import { createApp, toNodeListener } from "h3";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { McpPublicError, type McpActorContext } from "./contracts.js";

type WriteMcpAudit = (typeof import("./audit-store.js"))["writeMcpAudit"];

const state = vi.hoisted(() => ({
  env: {
    MCP_ENABLED: true,
    MCP_SERVER_VERSION: "0.1.0",
    MCP_MAX_REQUEST_BYTES: 4_096,
    MCP_MAX_RESULT_BYTES: 2_048,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
    BETTER_AUTH_URL: "https://worker.example.com",
  },
  requireMcpActor: vi.fn(),
  createAdapters: vi.fn<() => Record<string, unknown>>(() => ({})),
  writeMcpAudit: vi.fn<WriteMcpAudit>(),
  realWriteMcpAudit: undefined as unknown as WriteMcpAudit,
  db: undefined as unknown as Db,
}));

vi.mock("../../env.js", () => ({ env: state.env }));
vi.mock("./request-context.js", () => ({
  requireMcpActor: state.requireMcpActor,
}));
vi.mock("../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../lib/adapters.js", () => ({ createAdapters: state.createAdapters }));
// Delegates to the real store unless a test makes it fail: the audit assertions
// elsewhere in this file read actual rows, so a blanket stub would hollow them out.
vi.mock("./audit-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./audit-store.js")>();
  state.realWriteMcpAudit = actual.writeMcpAudit;
  return { ...actual, writeMcpAudit: state.writeMcpAudit };
});

import type { Db } from "../db/client.js";
import { createTestDb } from "../db/test-db.js";
import { mcpAuditEvents, mcpRateLimitWindows, organization } from "../db/schema.js";

const mcpPost = (await import("../routes/mcp.post.js")).default;
const mcpGet = (await import("../routes/mcp.get.js")).default;
const mcpDelete = (await import("../routes/mcp.delete.js")).default;

const ACTOR: McpActorContext = {
  kind: "user",
  subject: "user_1",
  userId: "user_1",
  clientId: "client_1",
  organizationId: "org_1",
  organizationSlug: "ai-workflow",
  role: "member",
  scopes: new Set(["mcp:read"]),
  audience: "https://worker.example.com/mcp",
};

beforeAll(async () => {
  state.db = await createTestDb();
  await db().insert(organization).values({
    id: ACTOR.organizationId,
    name: "MCP transport",
    slug: ACTOR.organizationSlug,
  });
});

beforeEach(async () => {
  vi.clearAllMocks();
  state.env.MCP_ENABLED = true;
  state.env.MCP_MAX_REQUEST_BYTES = 4_096;
  state.env.MCP_READ_RATE_LIMIT_PER_MINUTE = 120;
  state.env.MCP_MUTATION_RATE_LIMIT_PER_MINUTE = 20;
  state.requireMcpActor.mockImplementation(async (request: Request) => {
    const authorization = request.headers.get("authorization");
    if (authorization === "Bearer valid-token") return ACTOR;
    throw new McpPublicError("UNAUTHENTICATED", "Authentication required", false);
  });
  state.createAdapters.mockImplementation(() => ({}));
  state.writeMcpAudit.mockImplementation((...args) => state.realWriteMcpAudit(...args));
  await db().delete(mcpAuditEvents);
  await db().delete(mcpRateLimitWindows);
});

function db(): Db {
  return state.db;
}

// A literal, so this fails the day the published surface changes without intent.
// tool-catalog.test.ts is where the catalog, FIRST_SLICE_TOOLS and the registered
// set are pinned to one another.
const PUBLISHED = [
  "system.capabilities",
  "tickets.get",
  "tickets.list_runs",
  "runs.get",
  "runs.trace",
  "runs.result",
  "runs.diagnose",
  "workflows.dispatch_preflight",
  "workflows.dispatch",
  "workflows.list",
  "prompts.list",
  "prompts.get",
  "prompts.update",
  "workflows.create",
  "workflows.save_draft",
  "workflows.publish",
];

async function listedToolNames(response: Response): Promise<string[]> {
  const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };
  return body.result.tools.map((tool) => tool.name).sort();
}

// One error shape for the whole server: what the gate refuses reads exactly like
// what a tool handler raised, so an agent does not care where it was caught.
function errorPayload(text: string): {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
} {
  return (
    JSON.parse(text) as {
      error: { code: string; message: string; retryable: boolean; retryAfterMs?: number };
    }
  ).error;
}

const TICKET_CONTENT = {
  id: "10001",
  identifier: "PROJ-1",
  projectKey: "PROJ",
  title: "Add login page",
  description: "Build a login page",
  acceptanceCriteria: "Given valid credentials, then they log in.",
  comments: [],
  labels: ["frontend"],
  trackerStatus: "AI",
  trackerStatusId: "10000",
  attachments: [],
};

// Read back with plain selects, never through the stores the gate itself calls:
// a budget the implementation reports about itself is not evidence it was spent.
async function spentBudget(): Promise<Array<[string, number]>> {
  const rows = await db().select().from(mcpRateLimitWindows);
  return rows.map((row) => [row.toolName, row.requestCount]);
}

async function auditTrail(): Promise<Array<[string, string, string | null]>> {
  const rows = await db().select().from(mcpAuditEvents);
  return rows.map((row) => [row.toolName, row.outcome, row.errorCode]);
}

describe("stateless MCP Streamable HTTP", () => {
  it("handles a real 2025-11-25 initialize request without creating a session", async () => {
    const response = await post(initializeRequest(1));

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "ai-workflow-worker", version: "0.1.0" },
      },
    });
  });

  it("creates a fresh server and transport for every POST", async () => {
    const first = await post(initializeRequest(7));
    const second = await post(initializeRequest(7));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toMatchObject({ id: 7, result: { protocolVersion: "2025-11-25" } });
    expect(await second.json()).toMatchObject({ id: 7, result: { protocolVersion: "2025-11-25" } });
    expect(first.headers.get("mcp-session-id")).toBeNull();
    expect(second.headers.get("mcp-session-id")).toBeNull();
  });

  it("lists the whole registered surface on a sessionless follow-up request", async () => {
    const response = await post(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { "mcp-protocol-version": "2025-11-25" },
    );

    expect(response.status).toBe(200);
    await expect(listedToolNames(response)).resolves.toEqual([...PUBLISHED].sort());
  });

  it("rejects non-JSON content before authentication", async () => {
    const response = await post(initializeRequest(3), { "content-type": "text/plain" });

    expect(response.status).toBe(415);
    expect(state.requireMcpActor).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: { data: { code: "VALIDATION_FAILED" } },
    });
  });

  it("rejects request bodies over the configured byte limit", async () => {
    state.env.MCP_MAX_REQUEST_BYTES = 32;

    const response = await post(initializeRequest(4));

    expect(response.status).toBe(413);
    expect(state.requireMcpActor).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: { data: { code: "VALIDATION_FAILED" } },
    });
  });

  it("rejects a chunked body as soon as streamed bytes exceed the limit", async () => {
    state.env.MCP_MAX_REQUEST_BYTES = 48;

    const { response, respondedBeforeRequestEnd } = await postChunked([
      Buffer.alloc(24, "a"),
      Buffer.alloc(24, "b"),
      Buffer.alloc(24, "c"),
    ]);

    expect(respondedBeforeRequestEnd).toBe(true);
    expect(response.status).toBe(413);
    expect(state.requireMcpActor).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: { data: { code: "VALIDATION_FAILED" } },
    });
  });

  it("returns the JSON-RPC parse error for malformed JSON", async () => {
    const response = await postRaw('{"jsonrpc":"2.0",');

    expect(response.status).toBe(400);
    expect(state.requireMcpActor).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32700,
        message: "Parse error",
        data: { code: "VALIDATION_FAILED", retryable: false },
      },
      id: null,
    });
  });

  it("rejects batches and protocol versions other than 2025-11-25", async () => {
    const batch = await post([initializeRequest(1), initializeRequest(2)]);
    const oldVersion = await post({
      ...initializeRequest(5),
      params: { ...initializeRequest(5).params, protocolVersion: "2025-06-18" },
    });

    expect(batch.status).toBe(400);
    expect(oldVersion.status).toBe(400);
    await expect(batch.json()).resolves.toMatchObject({
      error: { data: { code: "VALIDATION_FAILED" } },
    });
    await expect(oldVersion.json()).resolves.toMatchObject({
      error: { data: { code: "VALIDATION_FAILED" } },
    });
  });

  it.each([
    ["missing", {}],
    ["wrong", { "mcp-protocol-version": "2025-06-18" }],
  ])("rejects a tools/list follow-up with a %s protocol version before auth", async (_case, headers) => {
    const response = await post(
      { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} },
      headers,
    );

    expect(response.status).toBe(400);
    expect(state.requireMcpActor).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      id: 9,
      error: { data: { code: "VALIDATION_FAILED" } },
    });
  });

  it("returns a minimal bearer challenge for missing or wrong-audience tokens", async () => {
    const missing = await post(initializeRequest(6), {}, null);
    const wrongAudience = await post(initializeRequest(7), {}, "wrong-audience-token");

    const challenge =
      'Bearer resource_metadata="https://worker.example.com/.well-known/oauth-protected-resource/mcp", scope="mcp:read"';
    expect(missing.status).toBe(401);
    expect(wrongAudience.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe(challenge);
    expect(wrongAudience.headers.get("www-authenticate")).toBe(challenge);
    await expect(wrongAudience.json()).resolves.toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: "Authentication required",
        data: { code: "UNAUTHENTICATED", retryable: false },
      },
      id: null,
    });
  });

  // 504 and not 503: a timed-out effect may still be running, and collapsing it
  // onto the "backend is down" status would erase that at the HTTP layer.
  it("maps a timeout to 504 rather than the dependency status", async () => {
    state.requireMcpActor.mockRejectedValue(
      new McpPublicError("TIMEOUT", "Still running; retry with the same key", true),
    );

    const response = await post(initializeRequest(10));

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({
      error: { data: { code: "TIMEOUT", retryable: true } },
    });
  });

  it("returns 405 with Allow POST for GET and DELETE", async () => {
    const getResponse = await methodRequest(mcpGet, "GET");
    const deleteResponse = await methodRequest(mcpDelete, "DELETE");

    expect(getResponse.status).toBe(405);
    expect(deleteResponse.status).toBe(405);
    expect(getResponse.headers.get("allow")).toBe("POST");
    expect(deleteResponse.headers.get("allow")).toBe("POST");
  });

  it("returns 404 before authentication when MCP is disabled", async () => {
    state.env.MCP_ENABLED = false;

    const response = await post(initializeRequest(8));

    expect(response.status).toBe(404);
    expect(state.requireMcpActor).not.toHaveBeenCalled();
  });
});

describe("gate before the tool handler", () => {
  // Frozen clock, real timers: probes fired within one test have to land in one
  // rate-limit window, and a minute boundary falling between them would read as
  // a regression instead of the clock it is.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-08-12T09:30:10.000Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("charges an unknown tool name to the budget and the audit trail", async () => {
    const response = await postToolCall(toolCall(20, "tickets.nope"));

    const text = await toolErrorText(response);
    expect(errorPayload(text)).toMatchObject({ code: "VALIDATION_FAILED", retryable: false });
    await expect(spentBudget()).resolves.toEqual([["unrecognized", 1]]);
    await expect(auditTrail()).resolves.toEqual([
      ["unrecognized", "rejected", "VALIDATION_FAILED"],
    ]);
    const trail = await db().select().from(mcpAuditEvents);
    expect(JSON.stringify(trail)).not.toContain("nope");
  });

  it("charges arguments that miss the schema of a registered tool", async () => {
    const response = await postToolCall(toolCall(21, "system.capabilities", { extra: 1 }));

    const text = await toolErrorText(response);
    expect(errorPayload(text).code).toBe("VALIDATION_FAILED");
    expect(text).toContain("system.capabilities");
    // The key is named, its value is not: naming it is what an agent needs to
    // correct itself now that a blind retry costs a slot.
    expect(text).toContain("'extra'");
    await expect(spentBudget()).resolves.toEqual([["system.capabilities", 1]]);
    await expect(auditTrail()).resolves.toEqual([
      ["system.capabilities", "rejected", "VALIDATION_FAILED"],
    ]);
  });

  it("does not open a fresh budget for every invented name", async () => {
    await postToolCall(toolCall(22, "tickets.nope"));
    await postToolCall(toolCall(23, "runs.nope"));
    await postToolCall(toolCall(24, "system.nope"));

    await expect(spentBudget()).resolves.toEqual([["unrecognized", 3]]);
    await expect(auditTrail()).resolves.toHaveLength(3);
  });

  it("answers 429 once refused probes exhaust the budget", async () => {
    state.env.MCP_READ_RATE_LIMIT_PER_MINUTE = 1;

    const first = await postToolCall(toolCall(25, "tickets.nope"));
    const second = await postToolCall(toolCall(26, "tickets.nope"));

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toMatchObject({
      id: 26,
      error: { data: { code: "RATE_LIMITED", retryable: true } },
    });
    await expect(spentBudget()).resolves.toEqual([["unrecognized", 2]]);
    const trail = await auditTrail();
    expect(trail.map((row) => row[2]).sort()).toEqual(["RATE_LIMITED", "VALIDATION_FAILED"]);
  });

  it.each([
    ["a params object with no name", { jsonrpc: "2.0", id: 27, method: "tools/call", params: {} }],
    [
      "a name that is not a string",
      { jsonrpc: "2.0", id: 28, method: "tools/call", params: { name: 42, arguments: {} } },
    ],
  ])("refuses %s before resolving the actor", async (_case, body) => {
    const response = await postToolCall(body);

    expect(response.status).toBe(400);
    expect(state.requireMcpActor).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: { data: { code: "VALIDATION_FAILED" } },
    });
    await expect(spentBudget()).resolves.toEqual([]);
    await expect(auditTrail()).resolves.toEqual([]);
  });

  it("builds no server or adapters for a call it refuses", async () => {
    await postToolCall(toolCall(29, "tickets.nope"));

    expect(state.requireMcpActor).toHaveBeenCalledTimes(1);
    expect(state.createAdapters).not.toHaveBeenCalled();
  });

  it("leaves a served call charged exactly once", async () => {
    const response = await postToolCall(toolCall(30, "system.capabilities", {}));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 30,
      result: { structuredContent: { data: { deploymentClass: "dedicated-worker" } } },
    });
    expect(state.createAdapters).toHaveBeenCalledTimes(1);
    await expect(spentBudget()).resolves.toEqual([["system.capabilities", 1]]);
    const trail = await auditTrail();
    expect(trail.map((row) => `${row[0]}:${row[1]}`).sort()).toEqual([
      "system.capabilities:attempted",
      "system.capabilities:success",
    ]);
  });

  // Authorization is evaluated before the schema, so the answer a caller without
  // permission gets does not depend on whether it guessed the arguments right.
  // The refusal still consumes the dispatch bucket before it writes the audit row,
  // which bounds both permission probing and retained audit traffic.
  it("refuses a role that may not dispatch and charges the dispatch bucket", async () => {
    state.requireMcpActor.mockResolvedValue({
      ...ACTOR,
      scopes: new Set(["mcp:read", "runs:dispatch"]),
    });

    const response = await postToolCall(toolCall(31, "workflows.dispatch", {}));

    const text = await toolErrorText(response);
    expect(errorPayload(text)).toEqual({
      code: "FORBIDDEN",
      message: "Access denied",
      retryable: false,
    });
    await expect(spentBudget()).resolves.toEqual([["workflows.dispatch", 1]]);
    await expect(auditTrail()).resolves.toEqual([
      ["workflows.dispatch", "rejected", "FORBIDDEN"],
    ]);
    expect(state.createAdapters).not.toHaveBeenCalled();
  });

  it("rate-limits repeated forbidden dispatches before audit rows grow without bound", async () => {
    state.env.MCP_MUTATION_RATE_LIMIT_PER_MINUTE = 1;
    state.requireMcpActor.mockResolvedValue({
      ...ACTOR,
      scopes: new Set(["mcp:read", "runs:dispatch"]),
    });

    const first = await postToolCall(toolCall(44, "workflows.dispatch", {}));
    const second = await postToolCall(toolCall(45, "workflows.dispatch", {}));

    expect(errorPayload(await toolErrorText(first))).toMatchObject({ code: "FORBIDDEN" });
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toMatchObject({
      id: 45,
      error: { data: { code: "RATE_LIMITED", retryable: true } },
    });
    await expect(spentBudget()).resolves.toEqual([["workflows.dispatch", 2]]);
    await expect(auditTrail()).resolves.toEqual([
      ["workflows.dispatch", "rejected", "FORBIDDEN"],
      ["workflows.dispatch", "rejected", "RATE_LIMITED"],
    ]);
    expect(state.createAdapters).not.toHaveBeenCalled();
  });

  it("refuses a token without the read scope before it looks at the arguments", async () => {
    state.requireMcpActor.mockResolvedValue({ ...ACTOR, scopes: new Set(["runs:dispatch"]) });

    const response = await postToolCall(toolCall(42, "tickets.get", { nonsense: 1 }));

    const text = await toolErrorText(response);
    expect(errorPayload(text)).toEqual({
      code: "INSUFFICIENT_SCOPE",
      message: "Insufficient scope",
      retryable: false,
    });
    // Nothing of the arguments is described, because they were never read.
    expect(text).not.toContain("nonsense");
    await expect(spentBudget()).resolves.toEqual([["tickets.get", 1]]);
    await expect(auditTrail()).resolves.toEqual([
      ["tickets.get", "rejected", "INSUFFICIENT_SCOPE"],
    ]);
  });

  // CallToolRequest makes `arguments` optional, so this is a legal call and the
  // likeliest shape of an agent's very first one. The schema used to answer the
  // absent object with invalid_type, which cost a slot and left a rejected row.
  it("serves a call that omits arguments altogether, charged exactly once", async () => {
    const response = await postToolCall({
      jsonrpc: "2.0",
      id: 43,
      method: "tools/call",
      params: { name: "system.capabilities" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 43,
      result: { structuredContent: { data: { deploymentClass: "dedicated-worker" } } },
    });
    await expect(spentBudget()).resolves.toEqual([["system.capabilities", 1]]);
    const trail = await auditTrail();
    expect(trail.map((row) => `${row[0]}:${row[1]}`).sort()).toEqual([
      "system.capabilities:attempted",
      "system.capabilities:success",
    ]);
  });

  // tools/list answers with every registered schema and enters no tool handler,
  // so leaving it out would put the enumeration this gate exists to stop one
  // method name away. Sentinel bucket, because tools/list is not a tool.
  it("charges listing the surface and records it as an attempt", async () => {
    const first = await postToolList(34);
    await postToolList(35);

    expect(first.status).toBe(200);
    await expect(listedToolNames(first)).resolves.toEqual([...PUBLISHED].sort());
    await expect(spentBudget()).resolves.toEqual([["unrecognized", 2]]);
    await expect(auditTrail()).resolves.toEqual([
      ["unrecognized", "attempted", null],
      ["unrecognized", "attempted", null],
    ]);
  });

  // The wording the SDK gave named the offending key, and an agent that invented
  // an argument needs exactly that to fix its next call, which now costs it a slot.
  it("names the argument a caller invented without echoing its value", async () => {
    const response = await postToolCall(
      toolCall(36, "tickets.get", { ticketKey: "AIW-1", limit: 5 }),
    );
    const text = await toolErrorText(response);

    expect(text).toContain("tickets.get");
    expect(text).toContain("limit");
    expect(text).not.toContain("5");
    await expect(spentBudget()).resolves.toEqual([["tickets.get", 1]]);
  });

  it("reports the schema boundary rather than the value that broke it", async () => {
    const tooLong = "A".repeat(65);
    const response = await postToolCall(toolCall(37, "tickets.get", { ticketKey: tooLong }));
    const text = await toolErrorText(response);

    expect(text).toContain("ticketKey");
    expect(text).toContain("max 64");
    expect(text).not.toContain(tooLong);
  });

  // A notification is never executed by the SDK, so both shapes below would
  // otherwise be a free, unrecorded way to probe: one for a name, one for a
  // name-plus-arguments pair that a later real call can then rely on.
  it("charges a refused notification and answers it with the transport's silence", async () => {
    const response = await postToolCall(toolCallNotification("tickets.nope"));

    expect(response.status).toBe(202);
    await expect(response.text()).resolves.toBe("");
    await expect(spentBudget()).resolves.toEqual([["unrecognized", 1]]);
    await expect(auditTrail()).resolves.toEqual([
      ["unrecognized", "rejected", "VALIDATION_FAILED"],
    ]);
  });

  it("charges a notification whose name and arguments are valid", async () => {
    const response = await postToolCall(toolCallNotification("system.capabilities", {}));

    expect(response.status).toBe(202);
    await expect(spentBudget()).resolves.toEqual([["system.capabilities", 1]]);
    // Attempted and nothing else: the SDK accepts the notification and drops it,
    // so no handler ever writes a result row for this one.
    await expect(auditTrail()).resolves.toEqual([
      ["system.capabilities", "attempted", null],
    ]);
  });

  it("refuses the sentinel's own value like any other invented name", async () => {
    await postToolCall(toolCall(38, "unrecognized"));

    await expect(spentBudget()).resolves.toEqual([["unrecognized", 1]]);
    await expect(auditTrail()).resolves.toEqual([
      ["unrecognized", "rejected", "VALIDATION_FAILED"],
    ]);
  });

  // Fail-closed and reported as the outage it is: the audit table and the
  // rate-limit table share one database, so the caller must not read the same
  // failure once as retryable and once as final.
  it("refuses to serve a probe it cannot record", async () => {
    state.writeMcpAudit.mockRejectedValue(new Error("audit store is unreachable"));

    const response = await postToolCall(toolCall(39, "tickets.nope"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      id: 39,
      error: { data: { code: "DEPENDENCY_UNAVAILABLE", retryable: true } },
    });
    expect(state.createAdapters).not.toHaveBeenCalled();
  });

  it("charges a catalogued tool under its own name and hands its valid call to the tool", async () => {
    const invalid = await postToolCall(toolCall(32, "tickets.get", {}));
    const invalidText = await toolErrorText(invalid);

    expect(errorPayload(invalidText).code).toBe("VALIDATION_FAILED");
    expect(invalidText).toContain("ticketKey");
    await expect(spentBudget()).resolves.toEqual([["tickets.get", 1]]);
    expect(state.createAdapters).not.toHaveBeenCalled();

    // Closes the window C0 accepted: this name used to pass the gate and bounce
    // off the SDK, which had nothing registered under it. It is served now, and
    // the second charge below is the handler's only. A gate that also charged a
    // servable call would show 3 here and halve every budget.
    state.createAdapters.mockReturnValue({
      issueTracker: { fetchTicket: async () => TICKET_CONTENT },
    });
    const served = await postToolCall(toolCall(33, "tickets.get", { ticketKey: "PROJ-1" }));

    await expect(served.json()).resolves.toMatchObject({
      id: 33,
      result: { structuredContent: { data: { ticketKey: "PROJ-1" } } },
    });
    await expect(spentBudget()).resolves.toEqual([["tickets.get", 2]]);
    expect(state.createAdapters).toHaveBeenCalledTimes(1);
    const trail = await auditTrail();
    expect(trail.map((row) => `${row[0]}:${row[1]}`).sort()).toEqual([
      "tickets.get:attempted",
      "tickets.get:rejected",
      "tickets.get:success",
    ]);
  });
});

function postToolCall(body: unknown) {
  return post(body, { "mcp-protocol-version": "2025-11-25" });
}

function postToolList(id: number) {
  return postToolCall({ jsonrpc: "2.0", id, method: "tools/list", params: {} });
}

function toolCall(id: number, name: unknown, args: unknown = {}) {
  return {
    jsonrpc: "2.0" as const,
    id,
    method: "tools/call" as const,
    params: { name, arguments: args },
  };
}

// No id, which is what makes it a notification: the SDK accepts one and never
// executes it.
function toolCallNotification(name: string, args: unknown = {}) {
  return {
    jsonrpc: "2.0" as const,
    method: "tools/call" as const,
    params: { name, arguments: args },
  };
}

async function toolErrorText(response: Response): Promise<string> {
  const body = (await response.json()) as {
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
  };
  expect(response.status).toBe(200);
  expect(body.result?.isError).toBe(true);
  return body.result?.content?.[0]?.text ?? "";
}

function initializeRequest(id: number) {
  return {
    jsonrpc: "2.0" as const,
    id,
    method: "initialize" as const,
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "task-5-test", version: "1.0.0" },
    },
  };
}

async function post(
  body: unknown,
  headers: Record<string, string> = {},
  token: string | null = "valid-token",
) {
  const app = createApp();
  app.use("/", mcpPost);
  return requestApp(
    app,
    "/mcp",
    {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    },
  );
}

async function postRaw(body: string): Promise<Response> {
  const app = createApp();
  app.use("/", mcpPost);
  return requestApp(app, "/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: "Bearer valid-token",
      "content-type": "application/json",
    },
    body,
  });
}

async function postChunked(chunks: readonly Buffer[]): Promise<{
  response: Response;
  respondedBeforeRequestEnd: boolean;
}> {
  const app = createApp();
  app.use("/", mcpPost);
  const server = createServer(toNodeListener(app));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");

  const request = requestHttp({
    host: "127.0.0.1",
    port: address.port,
    path: "/mcp",
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: "Bearer valid-token",
      connection: "close",
      "content-type": "application/json",
    },
  });
  const responsePromise = new Promise<IncomingMessage>((resolve, reject) => {
    request.once("response", resolve);
    request.once("error", reject);
  });

  request.flushHeaders();
  for (const chunk of chunks) request.write(chunk);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const respondedBeforeRequestEnd = await Promise.race([
    responsePromise.then(() => true),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), 1_000);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  request.end();

  try {
    const nodeResponse = await responsePromise;
    const responseChunks: Buffer[] = [];
    for await (const chunk of nodeResponse) responseChunks.push(Buffer.from(chunk));
    return {
      respondedBeforeRequestEnd,
      response: new Response(Buffer.concat(responseChunks), {
        status: nodeResponse.statusCode,
        statusText: nodeResponse.statusMessage,
        headers: nodeResponse.headers as HeadersInit,
      }),
    };
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function methodRequest(handler: typeof mcpGet, method: "GET" | "DELETE") {
  const app = createApp();
  app.use("/", handler);
  return requestApp(app, "/mcp", { method });
}

async function requestApp(
  app: ReturnType<typeof createApp>,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const server = createServer(toNodeListener(app));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, init);
    const body = await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    server.close();
    await once(server, "close");
  }
}
