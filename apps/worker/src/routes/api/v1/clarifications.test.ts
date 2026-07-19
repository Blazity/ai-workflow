import { createApp, createRouter, toWebHandler } from "h3";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../db/client.js";
import { clarificationRequests, member, organization, user } from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";
import {
  answerClarification,
  createClarificationRequest,
  getClarification,
} from "../../../clarifications/store.js";
import { IssueTrackerNotFoundError } from "../../../adapters/issue-tracker/types.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  session: { user: { id: "user_admin" }, session: { id: "session_test" } } as unknown,
  env: { DASHBOARD_ORG_SLUG: "ai-workflow", MAX_CONCURRENT_AGENTS: 3 },
}));

const mocks = vi.hoisted(() => ({
  fetchTicket: vi.fn(),
  dispatchClarificationAnswered: vi.fn(),
  resolveAwaitingRun: vi.fn(),
}));

vi.mock("../../../../env.js", () => ({ env: state.env }));
vi.mock("../../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../../auth-instance.js", () => ({
  auth: { api: { getSession: vi.fn(async () => state.session) } },
}));
vi.mock("../../../lib/step-adapters.js", () => ({
  createStepAdapters: () => ({
    issueTracker: { fetchTicket: mocks.fetchTicket },
    runRegistry: {},
  }),
}));
vi.mock("../../../clarifications/dispatch.js", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dispatchClarificationAnswered: (...args: any[]) => mocks.dispatchClarificationAnswered(...args),
}));
vi.mock("../../../lib/telemetry/run-telemetry.js", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolveAwaitingRun: (...args: any[]) => mocks.resolveAwaitingRun(...args),
}));

const answerPost = (await import("./clarifications/[id]/answer.post.js")).default;

let db: Db;

function paramHandler(method: "get" | "post", pattern: string, route: unknown) {
  const app = createApp();
  const router = createRouter();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  router[method](pattern, route as any);
  app.use(router);
  return toWebHandler(app);
}

const answer = (id: string, body: unknown = { answer: "Use Next.js" }) =>
  paramHandler("post", "/api/v1/clarifications/:id/answer", answerPost)(
    new Request(`http://worker.test/api/v1/clarifications/${id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

async function seedPending(ticketKey = "AWT-1") {
  return createClarificationRequest(db, {
    ticketKey,
    runId: "run-asked",
    questions: ["What framework?"],
  });
}

async function forceDispatchedRun(id: string, runId: string) {
  await db
    .update(clarificationRequests)
    .set({ dispatchedRunId: runId })
    .where(eq(clarificationRequests.id, id));
}

/** Happy-path dispatch stand-in: runs the real answer CAS (as the real dispatch
 *  would under the claim), then reports a started resume run. */
function dispatchStarts(runId = "run-x") {
  mocks.dispatchClarificationAnswered.mockImplementation(async (input) => {
    if (!input.isRetry) {
      await answerClarification(db, {
        id: input.clarification.id,
        answer: input.answer,
        actor: input.actor,
      });
    }
    return { status: "started", runId };
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.session = { user: { id: "user_admin" }, session: { id: "session_test" } };
  mocks.fetchTicket.mockResolvedValue({ identifier: "AWT-1", trackerStatus: "backlog" });
  mocks.resolveAwaitingRun.mockResolvedValue(true);
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
  it("401s when unauthenticated", async () => {
    const row = await seedPending("AWT-1");
    state.session = null;
    const res = await answer(row.id);
    expect(res.status).toBe(401);
    expect(mocks.dispatchClarificationAnswered).not.toHaveBeenCalled();
  });

  it("403s a non-member", async () => {
    const row = await seedPending("AWT-1");
    state.session = { user: { id: "user_nobody" }, session: { id: "session_test" } };
    const res = await answer(row.id);
    expect(res.status).toBe(403);
    expect(mocks.dispatchClarificationAnswered).not.toHaveBeenCalled();
  });

  it("allows a plain member to answer (no role gate)", async () => {
    const row = await seedPending("AWT-1");
    state.session = { user: { id: "user_member" }, session: { id: "session_test" } };
    dispatchStarts();
    const res = await answer(row.id);
    expect(res.status).toBe(200);
  });

  it("answers a ticketless scope:any clarification without calling Jira", async () => {
    await db.insert(clarificationRequests).values({
      id: "clar-ticketless",
      ticketKey: null,
      subjectKey: "pr:github:acme/api:42",
      ownerToken: "owner-parked",
      runId: "run-ticketless",
      questions: ["Which fix should be applied?"],
      status: "pending",
      checkpointState: "ready",
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      cleanupState: "none",
    });
    dispatchStarts("run-ticketless-resume");

    const res = await answer("clar-ticketless");
    expect(res.status).toBe(200);
    expect(mocks.fetchTicket).not.toHaveBeenCalled();
    expect(mocks.dispatchClarificationAnswered).toHaveBeenCalledWith(
      expect.objectContaining({
        clarification: expect.objectContaining({
          ticketKey: null,
          subjectKey: "pr:github:acme/api:42",
        }),
      }),
    );
  });

  it("404s on an unknown clarification", async () => {
    const res = await answer("missing");
    expect(res.status).toBe(404);
    expect(mocks.dispatchClarificationAnswered).not.toHaveBeenCalled();
  });

  it("400s on an empty answer", async () => {
    const row = await seedPending("AWT-1");
    const res = await answer(row.id, { answer: "   " });
    expect(res.status).toBe(400);
    expect(mocks.dispatchClarificationAnswered).not.toHaveBeenCalled();
  });

  it("400s on an oversized answer", async () => {
    const row = await seedPending("AWT-1");
    const res = await answer(row.id, { answer: "x".repeat(10_001) });
    expect(res.status).toBe(400);
  });

  it("409s when already answered with a dispatched run", async () => {
    const row = await seedPending("AWT-1");
    await answerClarification(db, { id: row.id, answer: "prior", actor: { id: "u", label: "U" } });
    await forceDispatchedRun(row.id, "run-prior");
    const res = await answer(row.id);
    expect(res.status).toBe(409);
    expect(mocks.dispatchClarificationAnswered).not.toHaveBeenCalled();
  });

  it("re-dispatches an answered-without-run row on retry, skipping the CAS", async () => {
    const row = await seedPending("AWT-1");
    await answerClarification(db, { id: row.id, answer: "prior", actor: { id: "u", label: "U" } });
    mocks.dispatchClarificationAnswered.mockResolvedValue({ status: "started", runId: "run-retry" });

    const res = await answer(row.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runId).toBe("run-retry");
    expect(mocks.dispatchClarificationAnswered).toHaveBeenCalledWith(
      expect.objectContaining({ isRetry: true }),
    );
    expect((await getClarification(db, row.id))?.dispatchedRunId).toBeNull();
  });

  it("returns a retryable response when missing-owner recovery is at capacity", async () => {
    const row = await seedPending("AWT-1");
    await answerClarification(db, {
      id: row.id,
      answer: "prior",
      actor: { id: "u", label: "U" },
    });
    mocks.dispatchClarificationAnswered.mockResolvedValue({ status: "at_capacity" });

    const res = await answer(row.id);

    expect(res.status).toBe(503);
    expect((await getClarification(db, row.id))?.dispatchedRunId).toBeNull();
  });

  it("accepts an answer that is durably queued until its predecessor finishes parking", async () => {
    const row = await seedPending("AWT-1");
    mocks.dispatchClarificationAnswered.mockImplementation(async (input) => {
      await answerClarification(db, {
        id: input.clarification.id,
        answer: input.answer,
        actor: input.actor,
      });
      return { status: "recorded" };
    });

    const res = await answer(row.id);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expect.objectContaining({
      clarification: expect.objectContaining({ status: "answered", answer: "Use Next.js" }),
      runId: null,
    }));
    expect((await getClarification(db, row.id))?.dispatchedRunId).toBeNull();
  });

  it("410s, supersedes the row, and flips the asking run off awaiting when the ticket is gone", async () => {
    const row = await seedPending("AWT-1");
    mocks.fetchTicket.mockRejectedValue(new IssueTrackerNotFoundError("Issue", "AWT-1"));
    const res = await answer(row.id);
    expect(res.status).toBe(410);
    expect((await getClarification(db, row.id))?.status).toBe("superseded");
    expect(mocks.resolveAwaitingRun).toHaveBeenCalledWith(expect.anything(), "run-asked");
    expect(mocks.dispatchClarificationAnswered).not.toHaveBeenCalled();
  });

  it("410s and supersedes an answered retry-state row when the ticket is gone", async () => {
    const row = await seedPending("AWT-1");
    // Retry state: answered but no dispatched run. The ticket-wide pending
    // supersede misses it, so the by-id supersede must catch it.
    await answerClarification(db, { id: row.id, answer: "prior", actor: { id: "u", label: "U" } });
    mocks.fetchTicket.mockRejectedValue(new IssueTrackerNotFoundError("Issue", "AWT-1"));
    const res = await answer(row.id);
    expect(res.status).toBe(410);
    expect((await getClarification(db, row.id))?.status).toBe("superseded");
    expect(mocks.dispatchClarificationAnswered).not.toHaveBeenCalled();
  });

  it("answers and starts a candidate but leaves winner acknowledgement to the bound workflow", async () => {
    const row = await seedPending("AWT-1");
    dispatchStarts("run-x");

    const res = await answer(row.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runId).toBe("run-x");
    expect(body.clarification.status).toBe("answered");
    expect(body.clarification.dispatchedRunId).toBeNull();
    expect(body.clarification.answer).toBe("Use Next.js");
    expect(mocks.resolveAwaitingRun).not.toHaveBeenCalled();
    const stored = await getClarification(db, row.id);
    expect(stored?.dispatchedRunId).toBeNull();
  });
});
