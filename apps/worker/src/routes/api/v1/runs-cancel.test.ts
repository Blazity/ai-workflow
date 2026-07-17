import { createApp, createRouter, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ role: "admin" as "admin" | "member" }));
const mocks = vi.hoisted(() => ({
  listAll: vi.fn(),
  cancelRun: vi.fn(),
  cancelSubjectRun: vi.fn(),
  drain: vi.fn(),
}));

vi.mock("../../../../env.js", () => ({
  env: {
    MAX_CONCURRENT_AGENTS: 3,
    COLUMN_BACKLOG: "Backlog",
    JIRA_BACKLOG_TRANSITION_ID: undefined,
  },
}));
vi.mock("../../../db/client.js", () => ({ getDb: () => ({ db: true }) }));
vi.mock("../../../lib/auth/request-context.js", () => ({
  requireDashboardActor: vi.fn(async () => ({ id: "user-1", role: state.role })),
  toHttpError: (error: unknown) => {
    throw error;
  },
}));
vi.mock("../../../lib/adapters.js", () => ({
  createAdapters: () => ({
    runRegistry: { listAll: mocks.listAll },
    issueTracker: { moveTicket: vi.fn() },
  }),
}));
vi.mock("../../../lib/cancel-run.js", () => ({
  cancelRun: (...args: any[]) => mocks.cancelRun(...args),
  cancelSubjectRun: (...args: any[]) => mocks.cancelSubjectRun(...args),
}));
vi.mock("../../../lib/dispatch-trigger.js", () => ({
  drainOldestPendingTrigger: (...args: any[]) => mocks.drain(...args),
}));

const cancelPost = (await import("./runs/[runId]/cancel.post.js")).default;

function handler() {
  const app = createApp();
  const router = createRouter();
  router.post("/api/v1/runs/:runId/cancel", cancelPost);
  app.use(router);
  return toWebHandler(app);
}

function cancel(runId = "run-pr") {
  return handler()(new Request(`http://worker.test/api/v1/runs/${runId}/cancel`, { method: "POST" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.role = "admin";
  mocks.cancelRun.mockResolvedValue(true);
  mocks.cancelSubjectRun.mockResolvedValue(true);
  mocks.drain.mockResolvedValue(null);
});

describe("POST /api/v1/runs/:runId/cancel", () => {
  it("cancels a ticketless PR subject by run id", async () => {
    mocks.listAll.mockResolvedValue([
      {
        subjectKey: "pr:github:acme/api#42",
        ticketKey: null,
        ownerToken: "owner-pr",
        runId: "run-pr",
        state: "bound",
        kind: "pr_trigger",
      },
    ]);

    const response = await cancel();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "cancelled",
      runId: "run-pr",
      subjectKey: "pr:github:acme/api#42",
    });
    expect(mocks.cancelSubjectRun).toHaveBeenCalledWith(
      "pr:github:acme/api#42",
      "run-pr",
      expect.anything(),
      expect.any(Function),
    );
    const onReleased = mocks.cancelSubjectRun.mock.calls[0]![3];
    await onReleased("pr:github:acme/api#42");
    expect(mocks.drain).toHaveBeenCalledWith(
      "pr:github:acme/api#42",
      expect.objectContaining({ maxConcurrentAgents: 3 }),
    );
  });

  it("uses ticket cancellation semantics for ticket-backed runs", async () => {
    mocks.listAll.mockResolvedValue([
      {
        subjectKey: "ticket:jira:AIW-1",
        ticketKey: "AIW-1",
        ownerToken: "owner-ticket",
        runId: "run-ticket",
        state: "bound",
        kind: "ticket",
      },
    ]);

    expect((await cancel("run-ticket")).status).toBe(200);
    expect(mocks.cancelRun).toHaveBeenCalledWith(
      "AIW-1",
      "run-ticket",
      expect.anything(),
      expect.anything(),
      "Backlog",
      expect.any(Function),
    );
  });

  it("requires an administrator and an exact active run", async () => {
    state.role = "member";
    expect((await cancel()).status).toBe(403);
    expect(mocks.listAll).not.toHaveBeenCalled();

    state.role = "admin";
    mocks.listAll.mockResolvedValue([]);
    expect((await cancel("missing")).status).toBe(404);
  });

  it("returns retryable failure when Workflow cancellation is unconfirmed", async () => {
    mocks.listAll.mockResolvedValue([
      {
        subjectKey: "pr:github:acme/api#42",
        ticketKey: null,
        ownerToken: "owner-pr",
        runId: "run-pr",
        state: "bound",
        kind: "pr_trigger",
      },
    ]);
    mocks.cancelSubjectRun.mockResolvedValue(false);

    expect((await cancel()).status).toBe(503);
  });
});
