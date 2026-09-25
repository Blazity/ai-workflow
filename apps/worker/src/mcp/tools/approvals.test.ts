// The dashboard's Approvals screen, as tools: list the plans waiting on a person,
// read one in full, approve or reject it. Driven from the caller's side through a
// real MCP client, next to the dashboard's own HTTP routes on the same database,
// because the point of these tools is that the two doors agree.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApp, createRouter, toWebHandler } from "h3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canApproveWorkflowPlans, DashboardAuthError } from "@shared/contracts";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  sessionUserId: "user_admin",
  env: {
    DASHBOARD_ORG_SLUG: "ai-workflow",
    MAX_CONCURRENT_AGENTS: 3,
    MCP_SERVER_VERSION: "0.1.0",
    MCP_MAX_RESULT_BYTES: 524_288,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
    MCP_AUDIT_RETENTION_DAYS: 365,
  },
}));

const mocks = vi.hoisted(() => ({
  fetchTicket: vi.fn(),
  postComment: vi.fn(),
  dispatchPlanApproved: vi.fn(),
}));

vi.mock("../../infra/vcs-config.js", () => ({ env: state.env }));
vi.mock("../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../services/auth/auth-instance.js", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => ({
        user: { id: state.sessionUserId },
        session: { id: "session_test" },
      })),
    },
  },
}));
vi.mock("../../engine/support/adapters.js", async () => {
  const { adaptersFor } = await import("../../test-support/issue-tracker.js");
  return {
    createAdapters: () =>
      adaptersFor(
        { fetchTicket: mocks.fetchTicket, postComment: mocks.postComment } as never,
        { runRegistry: {} },
      ),
  };
});
// The run an approval starts is the engine's business and is proved in
// services/approvals; here only the decision and who may take it are under test.
vi.mock("../../services/approvals/dispatch.js", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dispatchPlanApproved: (...args: any[]) => mocks.dispatchPlanApproved(...args),
}));

import type { Db } from "../../db/client.js";
import {
  createApprovalRequest,
  decideApproval,
  getApproval,
} from "../../db/repositories/approvals.js";
import { member, organization, user } from "../../db/schema.js";
import { createTestDb } from "../../db/test-db.js";
import { approveApproval, rejectApproval } from "../../services/approvals/index.js";
import { settingsSnapshotFromEnvironment } from "../../services/settings/snapshot.js";
import { actorFor, depsFor } from "../../test-support/mcp.js";
import type { McpActorContext } from "../contracts.js";
import { policyFor } from "../policy.js";
import { mcpEnvelopeResult } from "../tool-catalog.js";
import { registerApprovalTools } from "./approvals.js";
import { MCP_CLIENT_INLINE_BYTES } from "./page-budget.js";

const approvePost = (await import("../../routes/api/v1/approvals/[id]/approve.post.js")).default;
const rejectPost = (await import("../../routes/api/v1/approvals/[id]/reject.post.js")).default;

const ORG_ID = "org_aiw";
const NOW = new Date("2026-09-25T10:00:00.000Z");
const KEY_ONE = "11111111-1111-4111-8111-111111111111";
const KEY_TWO = "22222222-2222-4222-8222-222222222222";

let db: Db;

beforeEach(async () => {
  vi.clearAllMocks();
  state.sessionUserId = "user_admin";
  mocks.fetchTicket.mockResolvedValue({ identifier: "AWT-1", trackerStatus: "AI" });
  mocks.postComment.mockResolvedValue(null);
  mocks.dispatchPlanApproved.mockImplementation(async (input) => {
    await input.onClaimed();
    return { status: "started", runId: "run-implementation" };
  });
  db = await createTestDb();
  state.db = db;
  await db.insert(organization).values({ id: ORG_ID, name: "AI Workflow", slug: "ai-workflow" });
  await db.insert(user).values([
    { id: "user_admin", name: "Admin", email: "admin@example.com", emailVerified: true },
    { id: "user_member", name: "Member", email: "member@example.com", emailVerified: true },
  ]);
  await db.insert(member).values([
    { id: "member_admin", organizationId: ORG_ID, userId: "user_admin", role: "admin" },
    { id: "member_member", organizationId: ORG_ID, userId: "user_member", role: "member" },
  ]);
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function connectedClient(actor: Partial<McpActorContext> = {}): Promise<Client> {
  const server = new McpServer({ name: "approvals-test", version: "0.1.0" });
  registerApprovalTools(
    server,
    depsFor(db, () => NOW, {
      actor: actorFor({
        organizationId: ORG_ID,
        userId: "user_admin",
        subject: "user:user_admin",
        role: "admin",
        scopes: new Set(["mcp:read", "runs:dispatch"]),
        ...actor,
      }),
    }),
  );
  const client = new Client({ name: "approvals-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(() => client.close(), () => server.close());
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function httpDecision(action: "approve" | "reject", id: string): Promise<Response> {
  const app = createApp();
  const router = createRouter();
  router.post(`/api/v1/approvals/:id/${action}`, action === "approve" ? approvePost : rejectPost);
  app.use(router);
  return toWebHandler(app)(
    new Request(`http://worker.test/api/v1/approvals/${id}/${action}`, { method: "POST" }),
  );
}

async function seedPending(ticketKey = "AWT-1", markdown = "# Plan\n\n1. Fix the null check.") {
  return createApprovalRequest(db, {
    ticketKey,
    definitionId: 1,
    definitionVersion: 1,
    runId: `run-filed-${ticketKey}`,
    plan: { markdown },
    assumptions: ["The fix stays inside acme/web."],
    repositoryScope: {
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          defaultBranch: "main",
          researchBranch: "main",
          researchBaseSha: "a".repeat(40),
          access: "write",
          rationale: "Holds the failing handler.",
        },
      ],
    },
  });
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

describe("approvals.list", () => {
  it("lists the plans waiting on a person, newest first, with what a decision needs", async () => {
    await seedPending("AWT-1");
    await seedPending("AWT-2");
    const decided = await seedPending("AWT-3");
    await decideApproval(db, {
      id: decided.id,
      decision: "rejected",
      actor: { id: "user_admin", label: "Admin" },
    });
    const client = await connectedClient({ role: "member", userId: "user_member" });

    const data = dataOf<{
      approvals: Array<Record<string, unknown>>;
      hasMore: boolean;
    }>(await client.callTool({ name: "approvals.list", arguments: {} }));

    expect(data.hasMore).toBe(false);
    expect(data.approvals.map((row) => row.ticketKey)).toEqual(["AWT-2", "AWT-1"]);
    expect(data.approvals[1]).toMatchObject({
      status: "pending",
      ticketKey: "AWT-1",
      filedByRunId: "run-filed-AWT-1",
      definitionId: 1,
      definitionVersion: 1,
      decidedBy: null,
      planExcerpt: "# Plan\n\n1. Fix the null check.",
      planLength: 30,
      assumptionCount: 1,
      repositories: [{ repoPath: "acme/web", access: "write" }],
    });
    expect(typeof data.approvals[1]!.approvalId).toBe("string");
  });

  it("includes decided plans when asked for every status, and says who decided", async () => {
    const decided = await seedPending("AWT-3");
    await decideApproval(db, {
      id: decided.id,
      decision: "rejected",
      actor: { id: "user_admin", label: "Admin" },
    });
    const client = await connectedClient();

    const data = dataOf<{ approvals: Array<Record<string, unknown>> }>(
      await client.callTool({ name: "approvals.list", arguments: { status: "all" } }),
    );

    expect(data.approvals).toMatchObject([
      { ticketKey: "AWT-3", status: "rejected", decidedBy: "Admin" },
    ]);
  });

  it("stays inside what a client shows inline at its default page, however long the plans", async () => {
    // Twenty long plans in multi-byte text: the listing carries an excerpt and a
    // length, never the plan, so the page cannot grow with what agents wrote.
    for (let index = 0; index < 20; index += 1) {
      await seedPending(`AWT-${index}`, `Zażółć gęślą jaźń ${"ą".repeat(40_000)}`);
    }
    const client = await connectedClient();

    const result = await client.callTool({ name: "approvals.list", arguments: {} });
    const data = dataOf<{ approvals: unknown[]; hasMore: boolean }>(result);

    expect(data.hasMore).toBe(true);
    expect(data.approvals.length).toBeGreaterThan(0);
    const wire = Buffer.byteLength(
      JSON.stringify(mcpEnvelopeResult(result.structuredContent as never)),
    );
    expect(wire).toBeLessThanOrEqual(MCP_CLIENT_INLINE_BYTES);
  });
});

describe("approvals.get", () => {
  it("returns the whole plan, its assumptions and the repositories it would write to", async () => {
    const row = await seedPending("AWT-1");
    const client = await connectedClient({ role: "member", userId: "user_member" });

    const data = dataOf(
      await client.callTool({ name: "approvals.get", arguments: { approvalId: row.id } }),
    );

    expect(data).toMatchObject({
      approvalId: row.id,
      status: "pending",
      ticketKey: "AWT-1",
      plan: {
        markdown: "# Plan\n\n1. Fix the null check.",
        offset: 0,
        length: 30,
        nextOffset: null,
      },
      assumptions: ["The fix stays inside acme/web."],
      repositories: [
        { provider: "github", repoPath: "acme/web", access: "write", rationale: "Holds the failing handler." },
      ],
    });
  });

  it("pages a plan too long for one reply instead of cutting it off", async () => {
    const plan = `Start ${"ż".repeat(60_000)} End`;
    const row = await seedPending("AWT-1", plan);
    const client = await connectedClient();

    let offset = 0;
    let read = "";
    for (let page = 0; page < 20; page += 1) {
      const result = await client.callTool({
        name: "approvals.get",
        arguments: { approvalId: row.id, planOffset: offset },
      });
      const wire = Buffer.byteLength(
        JSON.stringify(mcpEnvelopeResult(result.structuredContent as never)),
      );
      expect(wire).toBeLessThanOrEqual(MCP_CLIENT_INLINE_BYTES);
      const data = dataOf<{ plan: { markdown: string; nextOffset: number | null; length: number } }>(
        result,
      );
      expect(data.plan.length).toBe(plan.length);
      read += data.plan.markdown;
      if (data.plan.nextOffset === null) break;
      offset = data.plan.nextOffset;
    }

    expect(read).toBe(plan);
  });

  it("answers NOT_FOUND for an id that names no plan", async () => {
    const client = await connectedClient();

    const error = errorOf(
      await client.callTool({ name: "approvals.get", arguments: { approvalId: "missing" } }),
    );

    expect(error.code).toBe("NOT_FOUND");
  });
});

describe("approvals.approve", () => {
  it("approves the plan, starts its run and says which run to follow", async () => {
    const row = await seedPending("AWT-1");
    const client = await connectedClient();

    const data = dataOf(
      await client.callTool({
        name: "approvals.approve",
        arguments: { approvalId: row.id, idempotencyKey: KEY_ONE },
      }),
    );

    expect(data).toMatchObject({
      approvalId: row.id,
      ticketKey: "AWT-1",
      status: "approved",
      decidedBy: "Admin",
      runId: "run-implementation",
    });
    expect((await getApproval(db, row.id))?.status).toBe("approved");
    expect(mocks.dispatchPlanApproved).toHaveBeenCalledOnce();
    expect(mocks.postComment).toHaveBeenCalledWith(
      "AWT-1",
      "Plan approved by Admin, implementation started.",
    );
  });

  it("refuses approving a plan somebody already decided, and changes nothing", async () => {
    const row = await seedPending("AWT-1");
    await decideApproval(db, {
      id: row.id,
      decision: "rejected",
      actor: { id: "user_other", label: "Grace Hopper" },
    });
    const before = await getApproval(db, row.id);
    const client = await connectedClient();

    const error = errorOf(
      await client.callTool({
        name: "approvals.approve",
        arguments: { approvalId: row.id, idempotencyKey: KEY_ONE },
      }),
    );

    expect(error.code).toBe("CONFLICT");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("already rejected by Grace Hopper");
    expect(await getApproval(db, row.id)).toEqual(before);
    expect(mocks.dispatchPlanApproved).not.toHaveBeenCalled();
    expect(mocks.postComment).not.toHaveBeenCalled();
  });

  it("answers a second call under the same key from the first answer, not with a second run", async () => {
    const row = await seedPending("AWT-1");
    const client = await connectedClient();
    const args = { approvalId: row.id, idempotencyKey: KEY_ONE };

    const first = dataOf(await client.callTool({ name: "approvals.approve", arguments: args }));
    const second = dataOf(await client.callTool({ name: "approvals.approve", arguments: args }));

    expect(second).toEqual(first);
    expect(mocks.dispatchPlanApproved).toHaveBeenCalledOnce();
  });

  it("answers NOT_FOUND, naming the id, for an approval that does not exist", async () => {
    const client = await connectedClient();

    const error = errorOf(
      await client.callTool({
        name: "approvals.approve",
        arguments: { approvalId: "apr_missing", idempotencyKey: KEY_ONE },
      }),
    );

    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toContain("apr_missing");
  });

  it("leaves the plan pending when another run owns the ticket, and says to come back", async () => {
    const row = await seedPending("AWT-1");
    mocks.dispatchPlanApproved.mockResolvedValue({ status: "run_in_flight" });
    const client = await connectedClient();

    const error = errorOf(
      await client.callTool({
        name: "approvals.approve",
        arguments: { approvalId: row.id, idempotencyKey: KEY_ONE },
      }),
    );

    expect(error.code).toBe("CONFLICT");
    expect(error.retryable).toBe(true);
    expect((await getApproval(db, row.id))?.status).toBe("pending");
  });
});

describe("approvals.reject", () => {
  it("rejects the plan and tells the ticket who did", async () => {
    const row = await seedPending("AWT-1");
    const client = await connectedClient();

    const data = dataOf(
      await client.callTool({
        name: "approvals.reject",
        arguments: { approvalId: row.id, idempotencyKey: KEY_ONE },
      }),
    );

    expect(data).toMatchObject({
      approvalId: row.id,
      ticketKey: "AWT-1",
      status: "rejected",
      decidedBy: "Admin",
    });
    expect((await getApproval(db, row.id))?.status).toBe("rejected");
    expect(mocks.postComment).toHaveBeenCalledWith("AWT-1", "Plan rejected by Admin.");
    expect(mocks.dispatchPlanApproved).not.toHaveBeenCalled();
  });

  it("refuses rejecting a plan that was already approved, and changes nothing", async () => {
    const row = await seedPending("AWT-1");
    await decideApproval(db, {
      id: row.id,
      decision: "approved",
      actor: { id: "user_other", label: "Grace Hopper" },
    });
    const before = await getApproval(db, row.id);
    const client = await connectedClient();

    const error = errorOf(
      await client.callTool({
        name: "approvals.reject",
        arguments: { approvalId: row.id, idempotencyKey: KEY_TWO },
      }),
    );

    expect(error.code).toBe("CONFLICT");
    expect(error.message).toContain("already approved by Grace Hopper");
    expect(await getApproval(db, row.id)).toEqual(before);
    expect(mocks.postComment).not.toHaveBeenCalled();
  });
});

describe("who may decide a plan", () => {
  // One rule, whichever door: the dashboard asks canApproveWorkflowPlans, and so
  // does this surface, through the same service and through its policy.
  for (const action of ["approve", "reject"] as const) {
    it(`refuses a member on ${action} over MCP exactly where the dashboard refuses one`, async () => {
      const row = await seedPending("AWT-1");
      const before = await getApproval(db, row.id);

      state.sessionUserId = "user_member";
      const http = await httpDecision(action, row.id);
      const client = await connectedClient({ role: "member", userId: "user_member" });
      const mcp = errorOf(
        await client.callTool({
          name: `approvals.${action}`,
          arguments: { approvalId: row.id, idempotencyKey: KEY_ONE },
        }),
      );

      expect(http.status).toBe(403);
      expect(mcp.code).toBe("FORBIDDEN");
      expect(await getApproval(db, row.id)).toEqual(before);
      expect(mocks.dispatchPlanApproved).not.toHaveBeenCalled();
      expect(mocks.postComment).not.toHaveBeenCalled();
    });

    // The decision a plan waits on is a person's: a token with nobody behind it
    // is refused even when it carries the dispatch scope.
    it(`refuses a client-credentials token on ${action}`, async () => {
      const row = await seedPending("AWT-1");
      const client = await connectedClient({
        kind: "service",
        role: "service",
        userId: null,
        subject: "client:automation",
      });

      const error = errorOf(
        await client.callTool({
          name: `approvals.${action}`,
          arguments: { approvalId: row.id, idempotencyKey: KEY_ONE },
        }),
      );

      expect(error.code).toBe("FORBIDDEN");
      expect((await getApproval(db, row.id))?.status).toBe("pending");
    });
  }

  it("holds the rule in the service both doors call, not only in each door", async () => {
    const row = await seedPending("AWT-1");
    const settings = settingsSnapshotFromEnvironment();

    await expect(
      approveApproval(row.id, { userId: "user_member", role: "member" }, settings),
    ).rejects.toBeInstanceOf(DashboardAuthError);
    await expect(
      rejectApproval(row.id, { userId: "user_member", role: "member" }),
    ).rejects.toBeInstanceOf(DashboardAuthError);
    expect((await getApproval(db, row.id))?.status).toBe("pending");
  });

  it("admits over MCP exactly the roles the dashboard admits", () => {
    for (const tool of ["approvals.approve", "approvals.reject"] as const) {
      for (const role of ["owner", "admin", "member"] as const) {
        expect(policyFor(tool).roles.includes(role), `${tool} for ${role}`).toBe(
          canApproveWorkflowPlans(role),
        );
      }
      expect(policyFor(tool).roles).not.toContain("service");
      expect(policyFor(tool).scope).toBe("runs:dispatch");
    }
    // Reading the queue is open to every dashboard role, as GET /api/v1/approvals is.
    expect(policyFor("approvals.list").roles).toContain("member");
    expect(policyFor("approvals.get").roles).toContain("member");
  });
});
