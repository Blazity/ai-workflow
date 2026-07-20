import { createApp, createRouter, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../db/client.js";
import { member, organization, user } from "../../../db/schema.js";
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
  env: { DASHBOARD_ORG_SLUG: "ai-workflow" },
}));

const mocks = vi.hoisted(() => ({
  fetchTicket: vi.fn(),
  resumeHook: vi.fn(),
  getHookByToken: vi.fn(),
  resolveAwaitingRun: vi.fn(),
}));

vi.mock("../../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../../../env.js", () => ({ env: state.env }));
vi.mock("../../../auth-instance.js", () => ({
  auth: { api: { getSession: vi.fn(async () => state.session) } },
}));
vi.mock("../../../lib/step-adapters.js", () => ({
  createStepAdapters: () => ({ issueTracker: { fetchTicket: mocks.fetchTicket } }),
}));
vi.mock("workflow/api", () => ({
  resumeHook: (...args: unknown[]) => mocks.resumeHook(...args),
  getHookByToken: (...args: unknown[]) => mocks.getHookByToken(...args),
}));
vi.mock("../../../lib/telemetry/run-telemetry.js", () => ({
  resolveAwaitingRun: (...args: unknown[]) => mocks.resolveAwaitingRun(...args),
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
  const row = await prepareHookClarification(db, {
    ticketKey,
    subjectKey: ticketKey ? `ticket:jira:${ticketKey}` : "pr:github:acme/api:42",
    runId: "run-asked",
    blockId: "question",
    definitionId: 1,
    definitionVersion: 4,
    questions: ["What framework?"],
  });
  return publishHookClarification(db, row.id);
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.session = { user: { id: "user_admin" }, session: { id: "session_test" } };
  mocks.fetchTicket.mockResolvedValue({ identifier: "AWT-1" });
  mocks.resumeHook.mockResolvedValue({ runId: "run-asked" });
  mocks.getHookByToken.mockRejectedValue(new Error("hook consumed"));
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

  it("retires the clarification when its Jira ticket was deleted", async () => {
    const row = await seedPending();
    mocks.fetchTicket.mockRejectedValueOnce(
      new IssueTrackerNotFoundError("AWT-1", "Ticket was deleted"),
    );

    expect((await answer(row.id)).status).toBe(410);
    expect((await getHookClarification(db, row.id))?.status).toBe("superseded");
    expect(mocks.resumeHook).not.toHaveBeenCalled();
  });
});
