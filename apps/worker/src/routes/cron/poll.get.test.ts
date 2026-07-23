import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ order: [] as string[] }));
const mocks = vi.hoisted(() => ({
  dispatchTicket: vi.fn(),
  reconcileRuns: vi.fn(),
  reconcileClarifications: vi.fn(),
  recoverClarificationParking: vi.fn(),
  recoverClarificationProviderParking: vi.fn(),
  recoverClarifications: vi.fn(),
  classifyProtectedClarifications: vi.fn(),
  listProtectedClarifications: vi.fn(),
  startCleanups: vi.fn(),
  expireClarifications: vi.fn(),
  listDispatchBlockingApprovals: vi.fn(),
  getApproval: vi.fn(),
  rejectUndispatchableApproval: vi.fn(),
  dispatchPlanApproved: vi.fn(),
  drainOldestPendingTrigger: vi.fn(),
  listPendingTriggers: vi.fn(),
  deleteExpiredRunObservations: vi.fn(),
}));

vi.mock("../../../env.js", () => ({
  env: {
    CRON_SECRET: undefined,
    JIRA_PROJECT_KEY: "AIW",
    COLUMN_AI: "AI",
    COLUMN_BACKLOG: "Backlog",
    JIRA_BACKLOG_TRANSITION_ID: "41",
    DASHBOARD_ORIGIN: "https://dashboard.example",
    MAX_CONCURRENT_AGENTS: 1,
  },
}));
vi.mock("workflow/runtime", () => ({ getWorld: () => ({ runs: {} }) }));
vi.mock("../../db/client.js", () => ({ getDb: () => ({ db: true }) }));
vi.mock("../../lib/adapters.js", () => ({
  createAdapters: () => ({
    issueTracker: {
      searchTickets: vi.fn(async () => {
        state.order.push("discover");
        return ["AIW-1", "AIW-2"];
      }),
    },
    runRegistry: {},
    messaging: { notifyForTicket: vi.fn() },
  }),
}));
vi.mock("../../lib/dispatch.js", () => ({
  dispatchTicket: (...args: any[]) => mocks.dispatchTicket(...args),
}));
vi.mock("../../approvals/store.js", () => ({
  listDispatchBlockingApprovals: (...args: any[]) =>
    mocks.listDispatchBlockingApprovals(...args),
  getApproval: (...args: any[]) => mocks.getApproval(...args),
  rejectUndispatchableApproval: (...args: any[]) =>
    mocks.rejectUndispatchableApproval(...args),
}));
vi.mock("../../approvals/dispatch.js", () => ({
  dispatchPlanApproved: (...args: any[]) => mocks.dispatchPlanApproved(...args),
}));
vi.mock("../../lib/reconcile.js", () => ({
  reconcileRuns: (...args: any[]) => mocks.reconcileRuns(...args),
}));
vi.mock("../../clarifications/store.js", () => ({
  reconcileClarificationCheckpoints: (...args: any[]) =>
    mocks.reconcileClarifications(...args),
  classifyProtectedClarificationSubjects: (...args: any[]) =>
    mocks.classifyProtectedClarifications(...args),
  listProtectedClarificationSubjectKeys: (...args: any[]) =>
    mocks.listProtectedClarifications(...args),
}));
vi.mock("../../clarifications/reconciliation.js", () => ({
  recoverClarificationProviderParking: (...args: any[]) =>
    mocks.recoverClarificationProviderParking(...args),
  recoverInterruptedClarificationParking: (...args: any[]) =>
    mocks.recoverClarificationParking(...args),
  recoverUndispatchedClarificationSuccessors: (...args: any[]) =>
    mocks.recoverClarifications(...args),
  startQueuedClarificationSnapshotCleanups: (...args: any[]) =>
    mocks.startCleanups(...args),
}));
vi.mock("../../clarifications/expiry.js", () => ({
  expireHookClarifications: (...args: any[]) => mocks.expireClarifications(...args),
}));
vi.mock("../../lib/dispatch-trigger.js", () => ({
  drainOldestPendingTrigger: (...args: any[]) =>
    mocks.drainOldestPendingTrigger(...args),
}));
vi.mock("../../lib/trigger-delivery-store.js", () => ({
  listPendingTriggers: (...args: any[]) => mocks.listPendingTriggers(...args),
}));
vi.mock("../../run-observability/store.js", () => ({
  deleteExpiredRunObservations: (...args: any[]) =>
    mocks.deleteExpiredRunObservations(...args),
}));
vi.mock("../../post-pr-gate/gate-store.js", () => ({
  GateStore: class {
    purgeExpired = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock("../../lib/telemetry/collect-snapshots.js", () => ({
  collectSnapshots: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../lib/telemetry/run-telemetry.js", () => ({
  upsertRunSnapshots: vi.fn().mockResolvedValue(undefined),
}));

const poll = (await import("./poll.get.js")).default;

function request() {
  const app = createApp();
  app.use("/", poll);
  return toWebHandler(app)(new Request("http://worker.test/"));
}

describe("cron clarification recovery ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.order = [];
    mocks.reconcileClarifications.mockImplementation(async () => {
      state.order.push("reconcile-clarifications");
      return [];
    });
    mocks.recoverClarifications.mockImplementation(async () => {
      state.order.push("recover-clarifications");
      return 0;
    });
    mocks.recoverClarificationParking.mockImplementation(async () => {
      state.order.push("recover-clarification-parking");
      return 0;
    });
    mocks.recoverClarificationProviderParking.mockImplementation(async () => {
      state.order.push("recover-clarification-provider-parking");
      return 0;
    });
    mocks.classifyProtectedClarifications.mockImplementation(async () => {
      state.order.push("protect-clarifications");
      return {
        all: ["ticket:jira:AIW-1", "ticket:jira:AIW-CONTINUATION"],
        retained: ["ticket:jira:AIW-1"],
        terminal: ["ticket:jira:AIW-CONTINUATION"],
      };
    });
    mocks.listProtectedClarifications.mockImplementation(async () => {
      state.order.push("legacy-protect-clarifications");
      return [];
    });
    mocks.dispatchTicket.mockImplementation(async (ticketKey: string) => {
      state.order.push(`dispatch:${ticketKey}`);
      return { started: true };
    });
    mocks.reconcileRuns.mockResolvedValue({ cancelled: 0, cleaned: 0 });
    mocks.startCleanups.mockResolvedValue(0);
    mocks.expireClarifications.mockResolvedValue({ expired: 0, retryable: 0, cleanupFailed: 0 });
    mocks.listDispatchBlockingApprovals.mockResolvedValue([]);
    mocks.getApproval.mockResolvedValue(null);
    mocks.rejectUndispatchableApproval.mockResolvedValue(undefined);
    mocks.dispatchPlanApproved.mockResolvedValue({ status: "run_in_flight" });
    mocks.drainOldestPendingTrigger.mockResolvedValue(null);
    mocks.listPendingTriggers.mockResolvedValue([]);
    mocks.deleteExpiredRunObservations.mockResolvedValue({
      deleted: 0,
      runIds: [],
    });
  });

  it("protects same-run clarifications before discovering generic ticket work", async () => {
    const response = await request();

    expect(response.status).toBe(200);
    expect(state.order.slice(0, 2)).toEqual(["protect-clarifications", "discover"]);
    expect(mocks.classifyProtectedClarifications).toHaveBeenCalledOnce();
    expect(mocks.listProtectedClarifications).not.toHaveBeenCalled();
    expect(mocks.recoverClarificationProviderParking).not.toHaveBeenCalled();
    expect(state.order).toContain("dispatch:AIW-2");
    expect(state.order).not.toContain("dispatch:AIW-1");
    expect(mocks.reconcileRuns).toHaveBeenCalledWith(
      expect.any(Set),
      expect.anything(),
      expect.anything(),
      expect.any(Function),
      expect.any(Function),
      new Set(["ticket:jira:AIW-1"]),
      { db: true },
      new Set(["ticket:jira:AIW-CONTINUATION"]),
    );
    await expect(response.json()).resolves.toMatchObject({
      pendingRecovered: 0,
      replayRetention: { deleted: 0 },
      triggerRecovery: {
        released: { attempted: 0, started: 0, errors: 0 },
      },
    });
    expect(mocks.deleteExpiredRunObservations).toHaveBeenCalledWith({
      db: { db: true },
      limit: 100,
    });
  });

  it("deletes one bounded replay-retention batch without failing the poll", async () => {
    mocks.deleteExpiredRunObservations.mockResolvedValue({
      deleted: 100,
      runIds: Array.from({ length: 100 }, (_, index) => `run-${index}`),
    });

    const response = await request();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      replayRetention: { deleted: 100 },
    });
  });

  it("keeps polling when replay-retention cleanup fails", async () => {
    mocks.deleteExpiredRunObservations.mockRejectedValue(
      new Error("database unavailable"),
    );

    const response = await request();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      replayRetention: { deleted: 0 },
    });
  });

  it("reconciles retained owners, recovers approved plans, and protects approval paths from generic dispatch", async () => {
    const pending = {
      id: "approval-pending",
      ticketKey: "AIW-1",
      status: "pending",
      dispatchedRunId: null,
    };
    const approved = {
      id: "approval-approved",
      ticketKey: "AIW-2",
      status: "approved",
      dispatchedRunId: null,
      decidedById: "user-1",
      decidedByLabel: "Alice",
    };
    mocks.classifyProtectedClarifications.mockResolvedValue({
      all: [],
      retained: [],
      terminal: [],
    });
    mocks.listDispatchBlockingApprovals.mockImplementation(async () => {
      state.order.push("protect-approvals");
      return [pending, approved];
    });
    mocks.getApproval.mockResolvedValue(approved);
    mocks.dispatchPlanApproved.mockImplementation(async (input) => {
      state.order.push(`recover-approval:${input.approval.ticketKey}`);
      await input.onClaimed();
      return { status: "started", runId: "run-approved" };
    });
    mocks.reconcileRuns.mockImplementationOnce(async () => {
      state.order.push("reconcile-runs");
      return { cancelled: 0, cleaned: 1 };
    });

    const response = await request();

    expect(response.status).toBe(200);
    expect(state.order.indexOf("protect-approvals")).toBeLessThan(
      state.order.indexOf("discover"),
    );
    expect(state.order.indexOf("discover")).toBeLessThan(
      state.order.indexOf("reconcile-runs"),
    );
    expect(state.order.indexOf("reconcile-runs")).toBeLessThan(
      state.order.indexOf("recover-approval:AIW-2"),
    );
    expect(state.order).not.toContain("dispatch:AIW-1");
    expect(state.order).not.toContain("dispatch:AIW-2");
    expect(mocks.dispatchPlanApproved).toHaveBeenCalledWith(
      expect.objectContaining({
        approval: approved,
        actor: { id: "user-1", label: "Alice" },
        issueTracker: expect.anything(),
        runRegistry: expect.anything(),
        onClaimed: expect.any(Function),
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      approvalRecovery: { scanned: 1, started: 1, blocked: 0, errors: 0 },
    });
  });

  it("polls a bounded pending-trigger batch and stops after one start", async () => {
    mocks.listPendingTriggers.mockResolvedValue([
      { subjectKey: "pr:github:acme/app#1" },
      { subjectKey: "pr:github:acme/app#2" },
      { subjectKey: "pr:github:acme/app#3" },
    ]);
    mocks.drainOldestPendingTrigger
      .mockResolvedValueOnce({
        result: "error",
        diagnosticId: "AIW-DIAG-ingest-retry",
      })
      .mockResolvedValueOnce({ result: "started", runId: "run-trigger" })
      .mockResolvedValueOnce({ result: "started", runId: "run-should-not-start" });

    const response = await request();

    expect(mocks.listPendingTriggers).toHaveBeenCalledWith({ db: true }, 20);
    expect(mocks.drainOldestPendingTrigger).toHaveBeenCalledTimes(2);
    expect(mocks.drainOldestPendingTrigger.mock.calls.map(([subject]) => subject)).toEqual([
      "pr:github:acme/app#1",
      "pr:github:acme/app#2",
    ]);
    await expect(response.json()).resolves.toMatchObject({
      pendingRecovered: 1,
      triggerRecovery: {
        polled: { listed: 3, attempted: 2, started: 1, errors: 1 },
      },
    });
  });

  it("does not add a polled start after released-owner recovery starts one", async () => {
    mocks.reconcileRuns.mockImplementationOnce(async (...args: any[]) => {
      await args[4]("pr:github:acme/app#released");
      await args[4]("pr:github:acme/app#also-released");
      return { cancelled: 0, cleaned: 1 };
    });
    mocks.drainOldestPendingTrigger.mockResolvedValueOnce({
      result: "started",
      runId: "run-released",
    });
    mocks.listPendingTriggers.mockResolvedValue([
      { subjectKey: "pr:github:acme/app#orphan" },
    ]);

    const response = await request();

    expect(mocks.drainOldestPendingTrigger).toHaveBeenCalledOnce();
    expect(mocks.listPendingTriggers).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      pendingRecovered: 1,
      triggerRecovery: {
        released: { attempted: 1, started: 1, errors: 0 },
        polled: { listed: 0, attempted: 0, started: 0, errors: 0 },
      },
    });
  });
});
