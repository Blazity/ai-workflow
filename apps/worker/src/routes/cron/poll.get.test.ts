import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ order: [] as string[] }));
const mocks = vi.hoisted(() => ({
  dispatchTicket: vi.fn(),
  reconcileRuns: vi.fn(),
  reconcileClarifications: vi.fn(),
  recoverClarifications: vi.fn(),
  listProtectedClarifications: vi.fn(),
  startCleanups: vi.fn(),
  recoverAccepted: vi.fn(),
  recoverPending: vi.fn(),
}));

vi.mock("../../../env.js", () => ({
  env: {
    CRON_SECRET: undefined,
    JIRA_PROJECT_KEY: "AIW",
    COLUMN_AI: "AI",
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
vi.mock("../../lib/reconcile.js", () => ({
  reconcileRuns: (...args: any[]) => mocks.reconcileRuns(...args),
}));
vi.mock("../../clarifications/store.js", () => ({
  reconcileClarificationCheckpoints: (...args: any[]) =>
    mocks.reconcileClarifications(...args),
  listProtectedClarificationSubjectKeys: (...args: any[]) =>
    mocks.listProtectedClarifications(...args),
}));
vi.mock("../../clarifications/reconciliation.js", () => ({
  recoverUndispatchedClarificationSuccessors: (...args: any[]) =>
    mocks.recoverClarifications(...args),
  startQueuedClarificationSnapshotCleanups: (...args: any[]) =>
    mocks.startCleanups(...args),
}));
vi.mock("../../lib/trigger-delivery-store.js", () => ({
  listPendingSubjectKeys: vi.fn().mockResolvedValue([]),
  listRecoverableAcceptedTriggerDeliveries: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../lib/pending-trigger-recovery.js", () => ({
  recoverAcceptedTriggerDeliveries: (...args: any[]) => mocks.recoverAccepted(...args),
  recoverOrphanedPendingTriggers: (...args: any[]) => mocks.recoverPending(...args),
}));
vi.mock("../../lib/dispatch-trigger.js", () => ({
  drainOldestPendingTrigger: vi.fn().mockResolvedValue(null),
  recoverAcceptedTriggerDelivery: vi.fn().mockResolvedValue(null),
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
    mocks.listProtectedClarifications.mockImplementation(async () => {
      state.order.push("protect-clarifications");
      return ["ticket:jira:AIW-1"];
    });
    mocks.dispatchTicket.mockImplementation(async (ticketKey: string) => {
      state.order.push(`dispatch:${ticketKey}`);
      return { started: true };
    });
    mocks.reconcileRuns.mockResolvedValue({ cancelled: 0, cleaned: 0 });
    mocks.startCleanups.mockResolvedValue(0);
    mocks.recoverAccepted.mockImplementation(async () => {
      state.order.push("recover-accepted-triggers");
      return { scanned: 1, blocked: 0, attempted: 1, started: 1, errors: 0 };
    });
    mocks.recoverPending.mockResolvedValue({
      scanned: 0,
      blocked: 0,
      attempted: 0,
      started: 0,
      errors: 0,
    });
  });

  it("recovers and protects answered checkpoints before discovering generic ticket work", async () => {
    const response = await request();

    expect(response.status).toBe(200);
    expect(state.order.slice(0, 4)).toEqual([
      "reconcile-clarifications",
      "recover-clarifications",
      "protect-clarifications",
      "discover",
    ]);
    expect(state.order).toContain("dispatch:AIW-2");
    expect(state.order).not.toContain("dispatch:AIW-1");
    expect(state.order).toContain("recover-accepted-triggers");
    await expect(response.json()).resolves.toMatchObject({
      pendingRecovered: 1,
      triggerRecovery: {
        accepted: { attempted: 1, started: 1, errors: 0 },
      },
    });
  });
});
