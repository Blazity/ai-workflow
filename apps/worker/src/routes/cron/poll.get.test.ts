import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { logger } from "../../lib/logger.js";

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
  listApprovalParkedSubjects: vi.fn(),
  getApproval: vi.fn(),
  rejectUndispatchableApproval: vi.fn(),
  dispatchPlanApproved: vi.fn(),
  drainOldestPendingTrigger: vi.fn(),
  listPendingTriggers: vi.fn(),
  deleteExpiredRunObservations: vi.fn(),
  resumeClarificationFromComments: vi.fn(),
  recoverManualDispatches: vi.fn(),
  listRecoverableManualDispatches: vi.fn(),
  sweepOrphanedAwaitingRuns: vi.fn(),
  sweepOrphanedRunningRuns: vi.fn(),
  redispatchPendingWebhookDeliveries: vi.fn(),
  sweepWebhookRateLimits: vi.fn(),
  pruneMcpAudits: vi.fn(),
  sweepMcpRateLimits: vi.fn(),
  sweepMcpIdempotencyKeys: vi.fn(),
  sweepWebhookRejectionCounters: vi.fn(),
  sweepWebhookDeliveries: vi.fn(),
  createWebhookDispatchDeps: vi.fn(),
  runScheduleTriggerPass: vi.fn(),
  createScheduleDispatchDeps: vi.fn(),
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
  listApprovalParkedSubjects: (...args: any[]) =>
    mocks.listApprovalParkedSubjects(...args),
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
vi.mock("../../clarifications/resume-from-comments.js", () => ({
  resumeClarificationFromComments: (...args: any[]) =>
    mocks.resumeClarificationFromComments(...args),
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
vi.mock("../../manual-dispatch/service.js", () => ({
  recoverManualDispatches: (...args: unknown[]) =>
    mocks.recoverManualDispatches(...args),
}));
vi.mock("../../manual-dispatch/store.js", () => ({
  listRecoverableManualDispatches: (...args: unknown[]) =>
    mocks.listRecoverableManualDispatches(...args),
}));
vi.mock("../../webhook-trigger/delivery-store.js", () => ({
  sweepWebhookDeliveries: (...args: unknown[]) => mocks.sweepWebhookDeliveries(...args),
}));
vi.mock("../../webhook-trigger/dispatch-webhook-trigger.js", () => ({
  redispatchPendingWebhookDeliveries: (...args: unknown[]) =>
    mocks.redispatchPendingWebhookDeliveries(...args),
}));
vi.mock("../../webhook-trigger/rate-limit.js", () => ({
  sweepWebhookRateLimits: (...args: unknown[]) => mocks.sweepWebhookRateLimits(...args),
}));
vi.mock("../../webhook-trigger/rejection-counters.js", () => ({
  sweepWebhookRejectionCounters: (...args: unknown[]) =>
    mocks.sweepWebhookRejectionCounters(...args),
}));
vi.mock("../../mcp/audit-store.js", () => ({
  pruneMcpAudits: (...args: unknown[]) => mocks.pruneMcpAudits(...args),
}));
vi.mock("../../mcp/rate-limit-store.js", () => ({
  sweepMcpRateLimits: (...args: unknown[]) => mocks.sweepMcpRateLimits(...args),
}));
vi.mock("../../mcp/idempotency-store.js", () => ({
  sweepMcpIdempotencyKeys: (...args: unknown[]) =>
    mocks.sweepMcpIdempotencyKeys(...args),
}));
vi.mock("../webhooks/custom/[endpointId].post.js", () => ({
  createWebhookDispatchDeps: (...args: unknown[]) =>
    mocks.createWebhookDispatchDeps(...args),
}));
vi.mock("../../schedule-trigger/dispatch-schedule-trigger.js", () => ({
  runScheduleTriggerPass: (...args: unknown[]) =>
    mocks.runScheduleTriggerPass(...args),
  createScheduleDispatchDeps: (...args: unknown[]) =>
    mocks.createScheduleDispatchDeps(...args),
}));
vi.mock("../../lib/telemetry/collect-snapshots.js", () => ({
  collectSnapshots: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../lib/telemetry/run-telemetry.js", () => ({
  upsertRunSnapshots: vi.fn().mockResolvedValue(undefined),
  sweepOrphanedAwaitingRuns: (...args: unknown[]) =>
    mocks.sweepOrphanedAwaitingRuns(...args),
  sweepOrphanedRunningRuns: (...args: unknown[]) =>
    mocks.sweepOrphanedRunningRuns(...args),
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
    mocks.listApprovalParkedSubjects.mockResolvedValue([]);
    mocks.getApproval.mockResolvedValue(null);
    mocks.rejectUndispatchableApproval.mockResolvedValue(undefined);
    mocks.dispatchPlanApproved.mockResolvedValue({ status: "run_in_flight" });
    mocks.drainOldestPendingTrigger.mockResolvedValue(null);
    mocks.listPendingTriggers.mockResolvedValue([]);
    mocks.deleteExpiredRunObservations.mockResolvedValue({
      deleted: 0,
      runIds: [],
    });
    mocks.resumeClarificationFromComments.mockResolvedValue({ status: "no_clarification" });
    mocks.recoverManualDispatches.mockImplementation(async () => {
      state.order.push("recover-manual-dispatches");
      return { scanned: 0, started: 0, recovering: 0, failed: 0 };
    });
    mocks.listRecoverableManualDispatches.mockResolvedValue([]);
    mocks.sweepOrphanedAwaitingRuns.mockResolvedValue(0);
    mocks.sweepOrphanedRunningRuns.mockResolvedValue(0);
    mocks.redispatchPendingWebhookDeliveries.mockResolvedValue([]);
    mocks.sweepWebhookRateLimits.mockResolvedValue(undefined);
    mocks.pruneMcpAudits.mockResolvedValue({ deleted: 0 });
    mocks.sweepMcpRateLimits.mockResolvedValue(undefined);
    mocks.sweepMcpIdempotencyKeys.mockResolvedValue({ deleted: 0 });
    mocks.sweepWebhookRejectionCounters.mockResolvedValue(undefined);
    mocks.sweepWebhookDeliveries.mockResolvedValue(undefined);
    mocks.createWebhookDispatchDeps.mockReturnValue({ kind: "webhook-deps" });
    mocks.createScheduleDispatchDeps.mockReturnValue({ kind: "schedule-deps" });
    mocks.runScheduleTriggerPass.mockResolvedValue({
      evaluation: {
        evaluated: 0,
        revoked: 0,
        invalid: 0,
        due: 0,
        started: 0,
        skipped: 0,
        deferred: 0,
        errors: 0,
      },
      drain: { listed: 0, started: 0, revoked: 0, deferred: 0, errors: 0 },
      expired: 0,
      failures: 0,
    });
  });

  // "awaiting" is frozen against the snapshot write, and every writer that
  // clears it is best-effort, so the poll has to settle the leftovers.
  it("sweeps orphaned awaiting runs alongside the telemetry snapshot", async () => {
    expect((await request()).status).toBe(200);
    expect(mocks.sweepOrphanedAwaitingRuns).toHaveBeenCalledWith({ db: true });
    expect(mocks.sweepOrphanedRunningRuns).toHaveBeenCalledWith({ db: true });
  });

  it("keeps polling when the awaiting sweep fails", async () => {
    mocks.sweepOrphanedAwaitingRuns.mockRejectedValue(new Error("db down"));
    expect((await request()).status).toBe(200);
  });

  // A webhook delivery that could not start when it arrived is only ever started
  // by this drain, so the poll owns it exactly like the trigger inbox above.
  it("drains pending webhook deliveries and sweeps their counters", async () => {
    mocks.redispatchPendingWebhookDeliveries.mockResolvedValue([
      { result: "started", runId: "run-1" },
      { result: "error", reason: "AIW-DIAG-ingest-1" },
    ]);

    const response = await request();

    expect(response.status).toBe(200);
    expect(mocks.createWebhookDispatchDeps).toHaveBeenCalledWith({ db: true }, {});
    expect(mocks.redispatchPendingWebhookDeliveries).toHaveBeenCalledWith({
      kind: "webhook-deps",
    });
    expect(mocks.sweepWebhookRateLimits).toHaveBeenCalledWith({ db: true });
    expect(mocks.sweepWebhookRejectionCounters).toHaveBeenCalledWith({ db: true });
    expect(mocks.sweepWebhookDeliveries).toHaveBeenCalledWith({ db: true });
    await expect(response.json()).resolves.toMatchObject({
      webhookRecovery: { attempted: 2, started: 1, errors: 1 },
    });
  });

  it("keeps polling when the webhook drain or its sweeps fail", async () => {
    mocks.redispatchPendingWebhookDeliveries.mockRejectedValue(new Error("db down"));
    mocks.sweepWebhookRateLimits.mockRejectedValue(new Error("db down"));
    mocks.sweepWebhookRejectionCounters.mockRejectedValue(new Error("db down"));
    mocks.sweepWebhookDeliveries.mockRejectedValue(new Error("db down"));

    const response = await request();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      webhookRecovery: { attempted: 0, started: 0, errors: 1 },
    });
  });

  // Nothing else deletes MCP audit rows or spent rate windows. Retention runs
  // last so a failure earlier in the poll cannot strand it, and reports its
  // count so a sweep that never fires is visible rather than merely warned.
  it("sweeps MCP rate windows and reports the audit rows it retired", async () => {
    mocks.pruneMcpAudits.mockResolvedValue({ deleted: 42 });
    mocks.sweepMcpIdempotencyKeys.mockResolvedValue({ deleted: 7 });

    const response = await request();

    expect(response.status).toBe(200);
    expect(mocks.sweepMcpRateLimits).toHaveBeenCalledWith({ db: true });
    expect(mocks.pruneMcpAudits).toHaveBeenCalledWith(
      { db: true },
      expect.any(Date),
      { limit: 100 },
    );
    // Nothing on the request path deletes a spent idempotency key either, so
    // the same retention shape carries it: bounded batch, reported count.
    expect(mocks.sweepMcpIdempotencyKeys).toHaveBeenCalledWith(
      { db: true },
      expect.any(Date),
      { limit: 100 },
    );
    await expect(response.json()).resolves.toMatchObject({
      mcpAuditRetention: { deleted: 42 },
      mcpIdempotencyRetention: { deleted: 7 },
    });
  });

  it("keeps polling when the MCP retention sweep or the rate sweep fails", async () => {
    mocks.pruneMcpAudits.mockRejectedValue(new Error("db down"));
    mocks.sweepMcpRateLimits.mockRejectedValue(new Error("db down"));
    mocks.sweepMcpIdempotencyKeys.mockRejectedValue(new Error("db down"));

    const response = await request();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      mcpAuditRetention: { deleted: 0 },
      mcpIdempotencyRetention: { deleted: 0 },
    });
  });

  // Nothing external delivers a schedule occurrence, so this pass is the whole
  // trigger, and its metrics flow straight into the response under its own key.
  it("dispatches due schedule triggers and reports their metrics", async () => {
    const metrics = {
      evaluation: {
        evaluated: 3,
        revoked: 0,
        invalid: 0,
        due: 2,
        started: 1,
        skipped: 1,
        deferred: 0,
        errors: 0,
      },
      drain: { listed: 1, started: 1, revoked: 0, deferred: 0, errors: 0 },
      expired: 1,
      failures: 0,
    };
    mocks.runScheduleTriggerPass.mockResolvedValue(metrics);

    const response = await request();

    expect(response.status).toBe(200);
    expect(mocks.createScheduleDispatchDeps).toHaveBeenCalledWith(
      { db: true },
      {},
      1,
    );
    expect(mocks.runScheduleTriggerPass).toHaveBeenCalledWith({
      kind: "schedule-deps",
    });
    await expect(response.json()).resolves.toMatchObject({
      scheduleTriggers: metrics,
    });
  });

  it("keeps polling when the schedule trigger pass fails", async () => {
    mocks.runScheduleTriggerPass.mockRejectedValue(new Error("db down"));

    const response = await request();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      scheduleTriggers: {
        evaluation: {
          evaluated: 0,
          revoked: 0,
          invalid: 0,
          due: 0,
          started: 0,
          skipped: 0,
          deferred: 0,
          errors: 0,
        },
        drain: { listed: 0, started: 0, revoked: 0, deferred: 0, errors: 0 },
        expired: 0,
        failures: 1,
      },
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
    // AIW-1's planning run still holds the bound claim it parked on: reconciliation
    // must clean it up terminally, never through the orphan cancellation cascade
    // that would supersede the pending approval.
    mocks.listApprovalParkedSubjects.mockResolvedValue(["ticket:jira:AIW-1"]);
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
      state.order.indexOf("recover-manual-dispatches"),
    );
    expect(state.order.indexOf("recover-manual-dispatches")).toBeLessThan(
      state.order.indexOf("reconcile-runs"),
    );
    expect(state.order.indexOf("reconcile-runs")).toBeLessThan(
      state.order.indexOf("recover-approval:AIW-2"),
    );
    expect(state.order).not.toContain("dispatch:AIW-1");
    expect(state.order).not.toContain("dispatch:AIW-2");
    expect(mocks.reconcileRuns).toHaveBeenCalledWith(
      expect.any(Set),
      expect.anything(),
      expect.anything(),
      expect.any(Function),
      expect.any(Function),
      new Set(),
      { db: true },
      new Set(["ticket:jira:AIW-1"]),
    );
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
      manualDispatchRecovery: {
        scanned: 0,
        started: 0,
        recovering: 0,
        failed: 0,
      },
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

  it("resumes protected clarifications without dispatching, and skips the helper for open work", async () => {
    const response = await request();

    expect(response.status).toBe(200);
    // AIW-1 is protected: the poll tries to wake its suspended run (no nudge —
    // the cron JQL snapshot is not the human's commit gesture) and never dispatches.
    expect(mocks.resumeClarificationFromComments).toHaveBeenCalledWith(
      expect.objectContaining({ ticketKey: "AIW-1", allowNudge: false }),
    );
    expect(state.order).not.toContain("dispatch:AIW-1");
    // AIW-2 is not protected: it dispatches and never touches the resume helper.
    expect(mocks.resumeClarificationFromComments).not.toHaveBeenCalledWith(
      expect.objectContaining({ ticketKey: "AIW-2" }),
    );
    expect(state.order).toContain("dispatch:AIW-2");
  });

  // A refused dispatch left no trace at all, so a pool full of parked runs read
  // exactly like a dead cron: the ticket kept being discovered every tick and
  // nothing said why it never started.
  it("logs the reason a discovered ticket was refused", async () => {
    const info = vi.spyOn(logger, "info");
    mocks.dispatchTicket.mockImplementation(async (ticketKey: string) => {
      state.order.push(`dispatch:${ticketKey}`);
      return { started: false, reason: "at_capacity" };
    });

    expect((await request()).status).toBe(200);

    expect(info).toHaveBeenCalledWith(
      { ticketKey: "AIW-2", reason: "at_capacity" },
      "poll_dispatch_refused",
    );
    info.mockRestore();
  });

  it("does not log a refusal for a ticket that dispatched", async () => {
    const info = vi.spyOn(logger, "info");

    expect((await request()).status).toBe(200);

    expect(info).not.toHaveBeenCalledWith(
      expect.anything(),
      "poll_dispatch_refused",
    );
    info.mockRestore();
  });
});
