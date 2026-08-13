import { createApp, createRouter, toWebHandler } from "h3";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../db/client.js";
import { activeRuns, member, organization, user, workflowRuns } from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";
import {
  getHookClarification,
  prepareHookClarification,
  publishHookClarification,
} from "../../../clarifications/hook-store.js";
import { IssueTrackerNotFoundError } from "../../../adapters/issue-tracker/types.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  session: { user: { id: "user_admin" }, session: { id: "session_test" } } as unknown,
  env: { DASHBOARD_ORG_SLUG: "ai-workflow", COLUMN_AI: "AI" },
}));

const mocks = vi.hoisted(() => ({
  fetchTicket: vi.fn(),
  moveTicket: vi.fn(),
  postComment: vi.fn(),
  resumeHook: vi.fn(),
  getHookByToken: vi.fn(),
}));

vi.mock("../../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../../../env.js", () => ({ env: state.env }));
vi.mock("../../../auth-instance.js", () => ({
  auth: { api: { getSession: vi.fn(async () => state.session) } },
}));
vi.mock("../../../lib/adapters.js", () => ({
  createAdapters: () => ({
    issueTracker: {
      fetchTicket: mocks.fetchTicket,
      moveTicket: mocks.moveTicket,
      postComment: mocks.postComment,
    },
  }),
}));
vi.mock("workflow/api", () => ({
  resumeHook: (...args: unknown[]) => mocks.resumeHook(...args),
  getHookByToken: (...args: unknown[]) => mocks.getHookByToken(...args),
}));
const answerPost = (await import("./clarifications/[id]/answer.post.js")).default;
let db: Db;

function handler(route: unknown) {
  const app = createApp();
  const router = createRouter();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  router.post("/api/v1/clarifications/:id/answer", route as any);
  app.use(router);
  return toWebHandler(app);
}

const answer = (id: string, value = "Use Next.js") =>
  handler(answerPost)(
    new Request(`http://worker.test/api/v1/clarifications/${id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: value }),
    }),
  );

async function seedPending(ticketKey: string | null = "AWT-1") {
  const subjectKey = ticketKey ? `ticket:jira:${ticketKey}` : "pr:github:acme/api:42";
  const row = await prepareHookClarification(db, {
    ticketKey,
    subjectKey,
    runId: "run-asked",
    blockId: "question",
    definitionId: 1,
    definitionVersion: 4,
    questions: ["What framework?"],
  });
  // A run suspended on a clarification hook still holds its bound subject claim;
  // the answer's column move rides that exact owner.
  await db.insert(activeRuns).values({
    subjectKey,
    ticketKey,
    ownerToken: "owner-1",
    runId: "run-asked",
    state: "bound",
    runKind: "ticket",
  });
  return publishHookClarification(db, row.id);
}

function parkedRun(runId = "run-asked") {
  return db.insert(workflowRuns).values({
    runId,
    subjectKey: "ticket:jira:AWT-1",
    ticketKey: "AWT-1",
    status: "awaiting",
  });
}

const runStatus = (runId: string) =>
  db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.runId, runId))
    .then((r) => r[0]?.status);

beforeEach(async () => {
  vi.clearAllMocks();
  state.session = { user: { id: "user_admin" }, session: { id: "session_test" } };
  // The question parked the ticket in the backlog, which is where every answer
  // starts from.
  mocks.fetchTicket.mockResolvedValue({ identifier: "AWT-1", trackerStatus: "AI Backlog" });
  mocks.moveTicket.mockResolvedValue(undefined);
  mocks.postComment.mockResolvedValue(null);
  mocks.resumeHook.mockResolvedValue({ runId: "run-asked" });
  mocks.getHookByToken.mockRejectedValue(new Error("hook consumed"));
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
}, 30_000);

describe("POST /api/v1/clarifications/:id/answer", () => {
  it("requires an authenticated organization member", async () => {
    const row = await seedPending();
    state.session = null;
    expect((await answer(row.id)).status).toBe(401);

    state.session = { user: { id: "unknown" }, session: { id: "session_test" } };
    expect((await answer(row.id)).status).toBe(403);
    expect(mocks.resumeHook).not.toHaveBeenCalled();
  });

  it("records the answer and resumes the asking run", async () => {
    const row = await seedPending();
    state.session = { user: { id: "user_member" }, session: { id: "session_test" } };

    const response = await answer(row.id);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({ runId: "run-asked" }));
    expect(mocks.resumeHook).toHaveBeenCalledWith(
      row.hookToken,
      expect.objectContaining({ answer: "Use Next.js", answeredById: "user_member" }),
    );
    expect((await getHookClarification(db, row.id))?.status).toBe("answered");
  });

  it("supports ticketless PR review clarifications without calling Jira", async () => {
    const row = await seedPending(null);
    expect((await answer(row.id)).status).toBe(200);
    expect(mocks.fetchTicket).not.toHaveBeenCalled();
    expect(mocks.moveTicket).not.toHaveBeenCalled();
    expect(mocks.postComment).not.toHaveBeenCalled();
  });

  it("accepts an identical retry after the hook was already consumed", async () => {
    const row = await seedPending();
    expect((await answer(row.id)).status).toBe(200);
    mocks.resumeHook.mockRejectedValueOnce(new Error("already consumed"));

    const retry = await answer(row.id);

    expect(retry.status).toBe(200);
    expect((await retry.json()).runId).toBe("run-asked");
  });

  it("rejects a competing answer", async () => {
    const row = await seedPending();
    expect((await answer(row.id, "First answer")).status).toBe(200);
    expect((await answer(row.id, "Different answer")).status).toBe(409);
  });

  it("returns a retryable error when the hook still exists after resume failure", async () => {
    const row = await seedPending();
    mocks.resumeHook.mockRejectedValueOnce(new Error("transport failed"));
    mocks.getHookByToken.mockResolvedValueOnce({ runId: "run-asked" });

    expect((await answer(row.id)).status).toBe(503);
    expect((await getHookClarification(db, row.id))?.answer).toBe("Use Next.js");
  });

  it("clears the asking run's park marker once the answer is delivered", async () => {
    const row = await seedPending();
    await parkedRun();

    expect((await answer(row.id)).status).toBe(200);
    expect(await runStatus("run-asked")).toBe("running");
  });

  it("moves the ticket back to the AI column before the run wakes up", async () => {
    const row = await seedPending();
    await parkedRun();

    expect((await answer(row.id)).status).toBe(200);

    expect(mocks.moveTicket).toHaveBeenCalledWith("AWT-1", "AI");
    // Ordering is the point: Jira must never show AI Backlog for a run that is
    // already working again.
    expect(mocks.moveTicket.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.resumeHook.mock.invocationCallOrder[0]!,
    );
    expect(await runStatus("run-asked")).toBe("running");
  });

  it("keeps the answer retryable when the column transition fails", async () => {
    const row = await seedPending();
    await parkedRun();
    mocks.moveTicket.mockRejectedValueOnce(new Error("Jira 502"));

    expect((await answer(row.id)).status).toBe(503);

    // Nothing committed: the question is still answerable and the run still
    // parked, so the same answer can simply be submitted again.
    expect((await getHookClarification(db, row.id))?.status).toBe("pending");
    expect(mocks.resumeHook).not.toHaveBeenCalled();
    expect(await runStatus("run-asked")).toBe("awaiting");
  });

  it("does not repeat the transition or the answer comment on an identical retry", async () => {
    const row = await seedPending();
    await parkedRun();
    mocks.resumeHook.mockRejectedValueOnce(new Error("transport failed"));
    mocks.getHookByToken.mockResolvedValueOnce({ runId: "run-asked" });
    expect((await answer(row.id)).status).toBe(503);
    expect(mocks.moveTicket).toHaveBeenCalledTimes(1);
    expect(mocks.postComment).toHaveBeenCalledTimes(1);

    // The first attempt already landed the ticket in the AI column.
    mocks.fetchTicket.mockResolvedValue({ identifier: "AWT-1", trackerStatus: "AI" });

    const retry = await answer(row.id);

    expect(retry.status).toBe(200);
    expect(mocks.moveTicket).toHaveBeenCalledTimes(1);
    // The retry re-drives the resume, not the ticket trace: a second identical
    // comment would just be noise in the customer's ticket.
    expect(mocks.postComment).toHaveBeenCalledTimes(1);
    expect(await runStatus("run-asked")).toBe("running");
  });

  it("mirrors the answer into the ticket so the question thread does not end in silence", async () => {
    const row = await seedPending();
    await parkedRun();
    state.session = { user: { id: "user_member" }, session: { id: "session_test" } };

    expect((await answer(row.id)).status).toBe(200);

    expect(mocks.postComment).toHaveBeenCalledTimes(1);
    const [ticketKey, body] = mocks.postComment.mock.calls[0] as [string, string];
    expect(ticketKey).toBe("AWT-1");
    expect(body).toContain("Use Next.js");
    expect(body).toContain("Member");
  });

  it("delivers the answer even when the ticket trace comment fails", async () => {
    const row = await seedPending();
    await parkedRun();
    mocks.postComment.mockRejectedValueOnce(new Error("Jira 500"));

    // A missing comment is a cosmetic loss; refusing the answer over it would
    // park a run that a human already unblocked.
    expect((await answer(row.id)).status).toBe(200);
    expect(mocks.resumeHook).toHaveBeenCalledTimes(1);
    expect((await getHookClarification(db, row.id))?.status).toBe("answered");
    expect(await runStatus("run-asked")).toBe("running");
  });

  it("skips the transition when the asking run no longer holds its claim", async () => {
    const row = await seedPending();
    await parkedRun();
    await db.delete(activeRuns);

    // A run without a bound claim can never work the ticket, so moving it would
    // be wrong. The answer itself still stands.
    expect((await answer(row.id)).status).toBe(200);
    expect(mocks.moveTicket).not.toHaveBeenCalled();
  });

  it("leaves the park marker in place when the resume can still be retried", async () => {
    const row = await seedPending();
    await parkedRun();
    mocks.resumeHook.mockRejectedValueOnce(new Error("transport failed"));
    mocks.getHookByToken.mockResolvedValueOnce({ runId: "run-asked" });

    expect((await answer(row.id)).status).toBe(503);
    expect(await runStatus("run-asked")).toBe("awaiting");
  });

  it("retires the clarification when its Jira ticket was deleted", async () => {
    const row = await seedPending();
    await parkedRun();
    mocks.fetchTicket.mockRejectedValueOnce(
      new IssueTrackerNotFoundError("AWT-1", "Ticket was deleted"),
    );

    expect((await answer(row.id)).status).toBe(410);
    expect((await getHookClarification(db, row.id))?.status).toBe("superseded");
    expect(mocks.resumeHook).not.toHaveBeenCalled();
    // The run is still suspended on a hook nobody can answer now, so it settles
    // as blocked. Recording success would freeze a dead run as a green result.
    expect(await runStatus("run-asked")).toBe("blocked");
  });
});
