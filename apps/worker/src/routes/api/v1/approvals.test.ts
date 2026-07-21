import { createApp, createRouter, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../db/client.js";
import { member, organization, user } from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";
import {
  createApprovalRequest,
  decideApproval,
  getApproval,
  setDispatchedRunId,
} from "../../../approvals/store.js";
import { IssueTrackerNotFoundError } from "../../../adapters/issue-tracker/types.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  sessionUserId: "user_admin",
  env: { DASHBOARD_ORG_SLUG: "ai-workflow", MAX_CONCURRENT_AGENTS: 3 },
}));

const mocks = vi.hoisted(() => ({
  fetchTicket: vi.fn(),
  postComment: vi.fn(),
  dispatchPlanApproved: vi.fn(),
}));

vi.mock("../../../../env.js", () => ({ env: state.env }));
vi.mock("../../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../../auth-instance.js", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => ({
        user: { id: state.sessionUserId },
        session: { id: "session_test" },
      })),
    },
  },
}));
vi.mock("../../../lib/step-adapters.js", () => ({
  createStepAdapters: () => ({
    issueTracker: { fetchTicket: mocks.fetchTicket, postComment: mocks.postComment },
    runRegistry: {},
  }),
}));
vi.mock("../../../approvals/dispatch.js", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dispatchPlanApproved: (...args: any[]) => mocks.dispatchPlanApproved(...args),
}));

const approvalsGet = (await import("./approvals.get.js")).default;
const approvePost = (await import("./approvals/[id]/approve.post.js")).default;
const rejectPost = (await import("./approvals/[id]/reject.post.js")).default;

let db: Db;

function handlerFor(route: unknown) {
  const app = createApp();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use("/", route as any);
  return toWebHandler(app);
}

function paramHandler(method: "get" | "post", pattern: string, route: unknown) {
  const app = createApp();
  const router = createRouter();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  router[method](pattern, route as any);
  app.use(router);
  return toWebHandler(app);
}

const approve = (id: string) =>
  paramHandler("post", "/api/v1/approvals/:id/approve", approvePost)(
    new Request(`http://worker.test/api/v1/approvals/${id}/approve`, { method: "POST" }),
  );
const reject = (id: string) =>
  paramHandler("post", "/api/v1/approvals/:id/reject", rejectPost)(
    new Request(`http://worker.test/api/v1/approvals/${id}/reject`, { method: "POST" }),
  );

async function seedPending(ticketKey = "AWT-1") {
  return createApprovalRequest(db, {
    ticketKey,
    definitionId: 1,
    definitionVersion: 1,
    runId: "run-produced",
    plan: { markdown: "# Plan" },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.sessionUserId = "user_admin";
  mocks.fetchTicket.mockResolvedValue({ identifier: "AWT-1", trackerStatus: "AI" });
  mocks.postComment.mockResolvedValue(null);
  db = await createTestDb();
  state.db = db;
  await db.insert(organization).values({ id: "org_aiw", name: "AI Workflow", slug: "ai-workflow" });
  await db.insert(user).values([
    { id: "user_admin", name: "Admin", email: "admin@example.com", emailVerified: true },
    { id: "user_member", name: "Member", email: "member@example.com", emailVerified: true },
  ]);
  await db.insert(member).values([
    { id: "member_admin", organizationId: "org_aiw", userId: "user_admin", role: "admin" },
    { id: "member_member", organizationId: "org_aiw", userId: "user_member", role: "member" },
  ]);
});

describe("GET /api/v1/approvals", () => {
  it("lists pending approvals newest first", async () => {
    await seedPending("AWT-1");
    await seedPending("AWT-2");
    const res = await handlerFor(approvalsGet)(new Request("http://worker.test/"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approvals).toHaveLength(2);
    expect(body.approvals[0].status).toBe("pending");
  });

  it("excludes decided rows unless status=all", async () => {
    const row = await seedPending("AWT-1");
    await decideApproval(db, { id: row.id, decision: "rejected", actor: { id: "u", label: "U" } });
    let res = await handlerFor(approvalsGet)(new Request("http://worker.test/"));
    expect((await res.json()).approvals).toHaveLength(0);
    res = await handlerFor(approvalsGet)(new Request("http://worker.test/?status=all"));
    expect((await res.json()).approvals).toHaveLength(1);
  });
});

describe("POST /api/v1/approvals/:id/approve", () => {
  it("approves and dispatches on the happy path", async () => {
    const row = await seedPending("AWT-1");
    mocks.dispatchPlanApproved.mockImplementation(async (input) => {
      await input.onClaimed();
      return { status: "started", runId: "run-x" };
    });

    const res = await approve(row.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runId).toBe("run-x");
    expect(body.approval.status).toBe("approved");
    expect(body.approval.dispatchedRunId).toBeNull();
    expect(mocks.dispatchPlanApproved).toHaveBeenCalledOnce();
    // The route wires the issue tracker through so dispatch can move the ticket
    // into the AI column under the claim before starting the run.
    expect(mocks.dispatchPlanApproved).toHaveBeenCalledWith(
      expect.objectContaining({ issueTracker: expect.anything() }),
    );
    expect(mocks.postComment).toHaveBeenCalledWith(
      "AWT-1",
      "Plan approved by Admin, implementation started.",
    );
    const stored = await getApproval(db, row.id);
    expect(stored?.status).toBe("approved");
    expect(stored?.dispatchedRunId).toBeNull();
  });

  it("rejects members with 403", async () => {
    const row = await seedPending("AWT-1");
    state.sessionUserId = "user_member";
    const res = await approve(row.id);
    expect(res.status).toBe(403);
    expect(mocks.dispatchPlanApproved).not.toHaveBeenCalled();
  });

  it("404s on an unknown approval", async () => {
    const res = await approve("missing");
    expect(res.status).toBe(404);
  });

  it("409s when already decided", async () => {
    const row = await seedPending("AWT-1");
    await decideApproval(db, { id: row.id, decision: "rejected", actor: { id: "u", label: "U" } });
    const res = await approve(row.id);
    expect(res.status).toBe(409);
    expect(mocks.dispatchPlanApproved).not.toHaveBeenCalled();
  });

  it("409s when already approved with a dispatched run", async () => {
    const row = await seedPending("AWT-1");
    await decideApproval(db, { id: row.id, decision: "approved", actor: { id: "u", label: "U" } });
    await setDispatchedRunId(db, row.id, "run-x");
    const res = await approve(row.id);
    expect(res.status).toBe(409);
    expect(mocks.dispatchPlanApproved).not.toHaveBeenCalled();
  });

  it("recovers when dispatch fails after the CAS: 500, then a retry dispatches", async () => {
    const row = await seedPending("AWT-1");
    mocks.dispatchPlanApproved.mockImplementationOnce(async (input) => {
      await input.onClaimed();
      throw new Error("start failed");
    });
    let res = await approve(row.id);
    expect(res.status).toBe(500);
    let stored = await getApproval(db, row.id);
    expect(stored?.status).toBe("approved");
    expect(stored?.dispatchedRunId).toBeNull();

    mocks.dispatchPlanApproved.mockImplementationOnce(async (input) => {
      await input.onClaimed();
      // The workflow candidate records the correlation only after it wins the
      // owner bind; the route itself must not write it from start()'s handle.
      await setDispatchedRunId(db, row.id, "run-retry");
      return { status: "started", runId: "run-retry" };
    });
    res = await approve(row.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runId).toBe("run-retry");
    expect(body.approval.status).toBe("approved");
    stored = await getApproval(db, row.id);
    expect(stored?.dispatchedRunId).toBe("run-retry");
    expect(mocks.postComment).toHaveBeenCalledWith(
      "AWT-1",
      "Plan approved by Admin, implementation started.",
    );
  });

  it("fails a retry inside onClaimed when a run was recorded concurrently", async () => {
    const row = await seedPending("AWT-1");
    await decideApproval(db, { id: row.id, decision: "approved", actor: { id: "u", label: "U" } });
    mocks.dispatchPlanApproved.mockImplementation(async (input) => {
      await setDispatchedRunId(db, row.id, "run-other");
      await input.onClaimed();
      return { status: "started", runId: "run-dup" };
    });
    const res = await approve(row.id);
    expect(res.status).toBe(409);
    expect((await getApproval(db, row.id))?.dispatchedRunId).toBe("run-other");
  });

  it("410s and auto-rejects when the definition is gone", async () => {
    const row = await seedPending("AWT-1");
    mocks.dispatchPlanApproved.mockResolvedValue({ status: "definition_gone" });
    const res = await approve(row.id);
    expect(res.status).toBe(410);
    const stored = await getApproval(db, row.id);
    expect(stored?.status).toBe("rejected");
    expect(stored?.decidedById).toBe("system");
  });

  it("410s but preserves a final approved decision when its pinned definition is unavailable", async () => {
    const row = await seedPending("AWT-1");
    await decideApproval(db, {
      id: row.id,
      decision: "approved",
      actor: { id: "user_admin", label: "Admin" },
    });
    mocks.dispatchPlanApproved.mockResolvedValue({ status: "definition_gone" });

    const res = await approve(row.id);

    expect(res.status).toBe(410);
    const stored = await getApproval(db, row.id);
    expect(stored?.status).toBe("approved");
    expect(stored?.decidedById).toBe("user_admin");
    expect(stored?.dispatchedRunId).toBeNull();
  });

  it("409s run_in_flight and leaves the row pending", async () => {
    const row = await seedPending("AWT-1");
    mocks.dispatchPlanApproved.mockResolvedValue({ status: "run_in_flight" });
    const res = await approve(row.id);
    expect(res.status).toBe(409);
    expect((await getApproval(db, row.id))?.status).toBe("pending");
  });

  it("410s and auto-rejects when the ticket is gone", async () => {
    const row = await seedPending("AWT-1");
    mocks.fetchTicket.mockRejectedValue(new IssueTrackerNotFoundError("Issue", "AWT-1"));
    const res = await approve(row.id);
    expect(res.status).toBe(410);
    const stored = await getApproval(db, row.id);
    expect(stored?.status).toBe("rejected");
    expect(stored?.decidedById).toBe("system");
    expect(mocks.dispatchPlanApproved).not.toHaveBeenCalled();
  });

  it("410s but preserves a final approved decision when the ticket is gone", async () => {
    const row = await seedPending("AWT-1");
    await decideApproval(db, {
      id: row.id,
      decision: "approved",
      actor: { id: "user_admin", label: "Admin" },
    });
    mocks.fetchTicket.mockRejectedValue(new IssueTrackerNotFoundError("Issue", "AWT-1"));

    const res = await approve(row.id);

    expect(res.status).toBe(410);
    const stored = await getApproval(db, row.id);
    expect(stored?.status).toBe("approved");
    expect(stored?.decidedById).toBe("user_admin");
    expect(stored?.dispatchedRunId).toBeNull();
    expect(mocks.dispatchPlanApproved).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/approvals/:id/reject", () => {
  it("rejects the plan and mirrors a comment", async () => {
    const row = await seedPending("AWT-1");
    const res = await reject(row.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approval.status).toBe("rejected");
    expect(body.runId).toBeNull();
    expect(mocks.postComment).toHaveBeenCalledWith("AWT-1", "Plan rejected by Admin.");
    expect((await getApproval(db, row.id))?.status).toBe("rejected");
  });

  it("rejects members with 403", async () => {
    const row = await seedPending("AWT-1");
    state.sessionUserId = "user_member";
    const res = await reject(row.id);
    expect(res.status).toBe(403);
  });

  it("409s when already decided", async () => {
    const row = await seedPending("AWT-1");
    await decideApproval(db, { id: row.id, decision: "approved", actor: { id: "u", label: "U" } });
    const res = await reject(row.id);
    expect(res.status).toBe(409);
  });
});
