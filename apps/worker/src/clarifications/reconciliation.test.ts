import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveRunOwnerError } from "../lib/run-control-errors.js";

const mocks = vi.hoisted(() => ({
  listUndispatched: vi.fn(),
  listParkingCandidates: vi.fn(),
  listProviderParkingCandidates: vi.fn(),
  claimProviderParking: vi.fn(),
  completeProviderParking: vi.fn(),
  publishCheckpoint: vi.fn(),
  dispatchAnswered: vi.fn(),
  resolveAwaitingRun: vi.fn(),
  listCleanup: vi.fn(),
  claimCleanup: vi.fn(),
  markCleanupFailed: vi.fn(),
  start: vi.fn(),
  getRun: vi.fn(),
  listWorkflowSteps: vi.fn(),
  stopSandboxes: vi.fn(),
  reconcileTicketTransitions: vi.fn(),
  moveTicketWithParkedOwnerIntent: vi.fn(),
  updateTicketLabelsWithIntent: vi.fn(),
}));

vi.mock("./store.js", () => ({
  listUndispatchedAnsweredClarifications: (...args: unknown[]) =>
    mocks.listUndispatched(...args),
  listClarificationParkingCandidates: (...args: unknown[]) =>
    mocks.listParkingCandidates(...args),
  listClarificationProviderParkingCandidates: (...args: unknown[]) =>
    mocks.listProviderParkingCandidates(...args),
  claimClarificationProviderParking: (...args: unknown[]) =>
    mocks.claimProviderParking(...args),
  completeClarificationProviderParking: (...args: unknown[]) =>
    mocks.completeProviderParking(...args),
  publishClarificationCheckpoint: (...args: unknown[]) =>
    mocks.publishCheckpoint(...args),
  listClarificationSnapshotCleanup: (...args: unknown[]) => mocks.listCleanup(...args),
  claimClarificationSnapshotCleanup: (...args: unknown[]) => mocks.claimCleanup(...args),
  markClarificationSnapshotCleanupFailed: (...args: unknown[]) =>
    mocks.markCleanupFailed(...args),
}));

vi.mock("./dispatch.js", () => ({
  dispatchClarificationAnswered: (...args: unknown[]) => mocks.dispatchAnswered(...args),
}));

vi.mock("../lib/telemetry/run-telemetry.js", () => ({
  resolveAwaitingRun: (...args: unknown[]) => mocks.resolveAwaitingRun(...args),
}));

vi.mock("workflow/api", () => ({
  start: (...args: unknown[]) => mocks.start(...args),
  getRun: (...args: unknown[]) => mocks.getRun(...args),
}));

vi.mock("workflow/runtime", () => ({
  getWorld: () => ({
    steps: { list: (...args: unknown[]) => mocks.listWorkflowSteps(...args) },
  }),
}));

vi.mock("../sandbox/stop-ticket-sandboxes.js", () => ({
  stopSandboxesByIds: (...args: unknown[]) => mocks.stopSandboxes(...args),
}));

vi.mock("../lib/ticket-transition.js", () => ({
  reconcileUnfinishedTicketTransitions: (...args: unknown[]) =>
    mocks.reconcileTicketTransitions(...args),
  moveTicketWithParkedOwnerIntent: (...args: unknown[]) =>
    mocks.moveTicketWithParkedOwnerIntent(...args),
}));

vi.mock("../lib/ticket-label-mutation.js", () => ({
  updateTicketLabelsWithIntent: (...args: unknown[]) =>
    mocks.updateTicketLabelsWithIntent(...args),
}));

vi.mock("../workflows/clarification-snapshot-cleanup.js", () => ({
  clarificationSnapshotCleanupWorkflow: vi.fn(),
}));

import {
  recoverInterruptedClarificationParking,
  recoverClarificationProviderParking,
  recoverUndispatchedClarificationSuccessors,
  startQueuedClarificationSnapshotCleanups,
} from "./reconciliation.js";

const db = {} as never;
const runRegistry = {} as never;
const issueTracker = {} as never;
const messaging = { notifyForTicket: vi.fn() } as never;

describe("clarification reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listUndispatched.mockResolvedValue([]);
    mocks.listParkingCandidates.mockResolvedValue([]);
    mocks.listProviderParkingCandidates.mockResolvedValue([]);
    mocks.claimProviderParking.mockResolvedValue(true);
    mocks.completeProviderParking.mockResolvedValue({ checkpointState: "ready" });
    mocks.publishCheckpoint.mockResolvedValue({
      row: {},
      supersededSnapshots: [],
      publishedNow: true,
    });
    mocks.listCleanup.mockResolvedValue([]);
    mocks.claimCleanup.mockResolvedValue(true);
    mocks.markCleanupFailed.mockResolvedValue(undefined);
    mocks.resolveAwaitingRun.mockResolvedValue(true);
    mocks.start.mockResolvedValue({ runId: "cleanup-run" });
    mocks.getRun.mockReturnValue({ status: Promise.resolve("running") });
    mocks.listWorkflowSteps.mockResolvedValue({
      data: [],
      cursor: null,
      hasMore: false,
    });
    mocks.stopSandboxes.mockResolvedValue(0);
    mocks.reconcileTicketTransitions.mockResolvedValue({
      settled: true,
      settledIntentIds: [],
      pendingIntentIds: [],
    });
    mocks.moveTicketWithParkedOwnerIntent.mockResolvedValue(undefined);
    mocks.updateTicketLabelsWithIntent.mockImplementation(
      async ({ issueTracker: tracker, ticketKey, changes }) => {
        await tracker.updateLabels?.(ticketKey, changes);
      },
    );
  });

  it("keeps provider parking unpublished while an ambiguous Jira call is unsettled", async () => {
    const candidate = {
      clarificationId: "clar-provider",
      ticketKey: "AWT-1",
      subjectKey: "ticket:jira:AWT-1",
      ownerToken: "owner-predecessor",
      runId: "run-predecessor",
    };
    mocks.listProviderParkingCandidates.mockResolvedValue([candidate]);
    mocks.reconcileTicketTransitions.mockResolvedValue({
      settled: false,
      settledIntentIds: [],
      pendingIntentIds: [17],
    });
    const registry = {
      get: vi.fn().mockResolvedValue({ ...candidate, state: "parked" }),
    } as never;

    await expect(
      recoverClarificationProviderParking({
        db,
        runRegistry: registry,
        issueTracker,
        messaging,
        dashboardOrigin: "https://dashboard.example",
        target: "Backlog",
      }),
    ).resolves.toBe(0);

    expect(mocks.claimProviderParking).toHaveBeenCalledWith(db, candidate.clarificationId);
    expect(mocks.moveTicketWithParkedOwnerIntent).not.toHaveBeenCalled();
    expect(mocks.completeProviderParking).not.toHaveBeenCalled();
    expect(mocks.publishCheckpoint).not.toHaveBeenCalled();
  });

  it("re-drives provider parking under the exact parked owner before publication", async () => {
    const candidate = {
      clarificationId: "clar-provider",
      ticketKey: "AWT-1",
      subjectKey: "ticket:jira:AWT-1",
      ownerToken: "owner-predecessor",
      runId: "run-predecessor",
    };
    const order: string[] = [];
    mocks.listProviderParkingCandidates.mockResolvedValue([candidate]);
    mocks.reconcileTicketTransitions.mockImplementation(async () => {
      order.push("settle");
      return { settled: true, settledIntentIds: [17], pendingIntentIds: [] };
    });
    mocks.moveTicketWithParkedOwnerIntent.mockImplementation(async () => {
      order.push("move");
    });
    mocks.completeProviderParking.mockImplementation(async () => {
      order.push("complete");
      return { checkpointState: "ready" };
    });
    mocks.publishCheckpoint.mockImplementation(async () => {
      order.push("publish");
      return { row: {}, supersededSnapshots: [], publishedNow: true };
    });
    const registry = {
      get: vi.fn().mockResolvedValue({ ...candidate, state: "parked" }),
    } as never;

    await expect(
      recoverClarificationProviderParking({
        db,
        runRegistry: registry,
        issueTracker,
        messaging,
        dashboardOrigin: "https://dashboard.example",
        target: { name: "Backlog", transitionId: "41" },
      }),
    ).resolves.toBe(1);

    const owner = {
      subjectKey: candidate.subjectKey,
      ownerToken: candidate.ownerToken,
      runId: candidate.runId,
    };
    expect(mocks.reconcileTicketTransitions).toHaveBeenCalledWith({
      db,
      issueTracker,
      ticketKey: candidate.ticketKey,
      owner,
    });
    expect(mocks.moveTicketWithParkedOwnerIntent).toHaveBeenCalledWith({
      db,
      issueTracker,
      ticketKey: candidate.ticketKey,
      target: { name: "Backlog", transitionId: "41" },
      owner,
    });
    expect(order).toEqual(["settle", "move", "complete", "publish"]);
  });

  it("restores the clarification label and notification before completing provider recovery", async () => {
    const candidate = {
      clarificationId: "clar-provider",
      ticketKey: "AWT-1",
      subjectKey: "ticket:jira:AWT-1",
      ownerToken: "owner-predecessor",
      runId: "run-predecessor",
    };
    const order: string[] = [];
    const tracker = {
      updateLabels: vi.fn(async () => {
        order.push("label");
      }),
    };
    const recoveryMessaging = {
      notifyForTicket: vi.fn(async () => {
        order.push("notify");
      }),
    };
    mocks.listProviderParkingCandidates.mockResolvedValue([candidate]);
    mocks.reconcileTicketTransitions.mockImplementation(async () => {
      order.push("settle");
      return { settled: true, settledIntentIds: [17], pendingIntentIds: [] };
    });
    mocks.moveTicketWithParkedOwnerIntent.mockImplementation(async () => {
      order.push("move");
    });
    mocks.completeProviderParking.mockImplementation(async () => {
      order.push("complete");
      return { checkpointState: "ready" };
    });
    mocks.publishCheckpoint.mockImplementation(async () => {
      order.push("publish");
      return { row: {}, supersededSnapshots: [], publishedNow: true };
    });
    const registry = {
      get: vi.fn().mockResolvedValue({ ...candidate, state: "parked" }),
    } as never;

    await expect(
      recoverClarificationProviderParking({
        db,
        runRegistry: registry,
        issueTracker: tracker as never,
        messaging: recoveryMessaging as never,
        dashboardOrigin: "https://dashboard.example",
        target: "Backlog",
      }),
    ).resolves.toBe(1);

    expect(tracker.updateLabels).toHaveBeenCalledWith("AWT-1", {
      add: ["needs-clarification"],
    });
    expect(mocks.updateTicketLabelsWithIntent).toHaveBeenCalledWith({
      db,
      issueTracker: tracker,
      ticketKey: "AWT-1",
      owner: {
        subjectKey: candidate.subjectKey,
        ownerToken: candidate.ownerToken,
        runId: candidate.runId,
      },
      requiredOwnerState: "parked",
      changes: { add: ["needs-clarification"] },
    });
    expect(recoveryMessaging.notifyForTicket).toHaveBeenCalledWith("AWT-1", {
      kind: "needs_clarification",
      dashboardUrl:
        "https://dashboard.example/ticket/AWT-1?run=run-predecessor",
    });
    expect(order).toEqual([
      "settle",
      "label",
      "move",
      "complete",
      "publish",
      "notify",
    ]);
  });

  it("does not continue provider parking after the exact parked owner is lost at a no-op label boundary", async () => {
    const candidate = {
      clarificationId: "clar-provider",
      ticketKey: "AWT-1",
      subjectKey: "ticket:jira:AWT-1",
      ownerToken: "owner-predecessor",
      runId: "run-predecessor",
    };
    mocks.listProviderParkingCandidates.mockResolvedValue([candidate]);
    mocks.updateTicketLabelsWithIntent.mockRejectedValue(
      new ActiveRunOwnerError(),
    );
    const registry = {
      get: vi.fn().mockResolvedValue({ ...candidate, state: "parked" }),
    } as never;
    const recoveryMessaging = {
      notifyForTicket: vi.fn(async () => {}),
    };

    await expect(
      recoverClarificationProviderParking({
        db,
        runRegistry: registry,
        issueTracker: { updateLabels: vi.fn() } as never,
        messaging: recoveryMessaging as never,
        dashboardOrigin: "https://dashboard.example",
        target: "Backlog",
      }),
    ).resolves.toBe(0);

    expect(mocks.moveTicketWithParkedOwnerIntent).not.toHaveBeenCalled();
    expect(mocks.completeProviderParking).not.toHaveBeenCalled();
    expect(mocks.publishCheckpoint).not.toHaveBeenCalled();
    expect(recoveryMessaging.notifyForTicket).not.toHaveBeenCalled();
  });

  it("attempts notification once after a retried durable provider recovery", async () => {
    const candidate = {
      clarificationId: "clar-provider",
      ticketKey: "AWT-1",
      subjectKey: "ticket:jira:AWT-1",
      ownerToken: "owner-predecessor",
      runId: "run-predecessor",
    };
    mocks.listProviderParkingCandidates
      .mockResolvedValueOnce([candidate])
      .mockResolvedValueOnce([candidate])
      .mockResolvedValue([]);
    mocks.moveTicketWithParkedOwnerIntent
      .mockRejectedValueOnce(new Error("Jira unavailable"))
      .mockResolvedValue(undefined);
    const registry = {
      get: vi.fn().mockResolvedValue({ ...candidate, state: "parked" }),
    } as never;
    const recoveryMessaging = {
      notifyForTicket: vi.fn(async () => {}),
    };
    const input = {
      db,
      runRegistry: registry,
      issueTracker: {
        updateLabels: vi.fn(),
      } as never,
      messaging: recoveryMessaging as never,
      dashboardOrigin: "https://dashboard.example",
      target: "Backlog",
    };

    await expect(recoverClarificationProviderParking(input)).resolves.toBe(0);
    expect(recoveryMessaging.notifyForTicket).not.toHaveBeenCalled();
    await expect(recoverClarificationProviderParking(input)).resolves.toBe(1);
    await expect(recoverClarificationProviderParking(input)).resolves.toBe(0);

    expect(mocks.updateTicketLabelsWithIntent).toHaveBeenCalledTimes(2);
    expect(mocks.publishCheckpoint).toHaveBeenCalledOnce();
    expect(recoveryMessaging.notifyForTicket).toHaveBeenCalledOnce();
  });

  it("lets only the durable publication winner notify provider-parking recovery", async () => {
    const candidate = {
      clarificationId: "clar-provider",
      ticketKey: "AWT-1",
      subjectKey: "ticket:jira:AWT-1",
      ownerToken: "owner-predecessor",
      runId: "run-predecessor",
    };
    mocks.listProviderParkingCandidates.mockResolvedValue([candidate]);
    mocks.publishCheckpoint.mockResolvedValue({
      row: {},
      supersededSnapshots: [],
      publishedNow: false,
    });
    const registry = {
      get: vi.fn().mockResolvedValue({ ...candidate, state: "parked" }),
    } as never;
    const recoveryMessaging = {
      notifyForTicket: vi.fn(async () => {}),
    };

    await expect(
      recoverClarificationProviderParking({
        db,
        runRegistry: registry,
        issueTracker,
        messaging: recoveryMessaging as never,
        dashboardOrigin: "https://dashboard.example",
        target: "Backlog",
      }),
    ).resolves.toBe(0);
    expect(recoveryMessaging.notifyForTicket).not.toHaveBeenCalled();
  });

  it("does not notify after cancellation closes the parked owner following publication", async () => {
    const candidate = {
      clarificationId: "clar-provider",
      ticketKey: "AWT-1",
      subjectKey: "ticket:jira:AWT-1",
      ownerToken: "owner-predecessor",
      runId: "run-predecessor",
    };
    mocks.listProviderParkingCandidates.mockResolvedValue([candidate]);
    const getOwner = vi
      .fn()
      .mockResolvedValueOnce({ ...candidate, state: "parked" })
      .mockResolvedValueOnce({ ...candidate, state: "cancelling" });
    const registry = {
      get: getOwner,
    } as never;
    const recoveryMessaging = {
      notifyForTicket: vi.fn(async () => {}),
    };

    await expect(
      recoverClarificationProviderParking({
        db,
        runRegistry: registry,
        issueTracker,
        messaging: recoveryMessaging as never,
        dashboardOrigin: "https://dashboard.example",
        target: "Backlog",
      }),
    ).resolves.toBe(1);
    expect(getOwner).toHaveBeenCalledTimes(2);
    expect(recoveryMessaging.notifyForTicket).not.toHaveBeenCalled();
  });

  it("does not re-drive provider parking unless the exact predecessor is parked", async () => {
    const candidate = {
      clarificationId: "clar-provider",
      ticketKey: "AWT-1",
      subjectKey: "ticket:jira:AWT-1",
      ownerToken: "owner-predecessor",
      runId: "run-predecessor",
    };
    mocks.listProviderParkingCandidates.mockResolvedValue([candidate]);
    const registry = {
      get: vi.fn().mockResolvedValue({ ...candidate, state: "cancelling" }),
    } as never;

    await expect(
      recoverClarificationProviderParking({
        db,
        runRegistry: registry,
        issueTracker,
        messaging,
        dashboardOrigin: "https://dashboard.example",
        target: "Backlog",
      }),
    ).resolves.toBe(0);

    expect(mocks.claimProviderParking).not.toHaveBeenCalled();
    expect(mocks.reconcileTicketTransitions).not.toHaveBeenCalled();
    expect(mocks.moveTicketWithParkedOwnerIntent).not.toHaveBeenCalled();
    expect(mocks.publishCheckpoint).not.toHaveBeenCalled();
  });

  it("recovers a published clarification whose workflow terminated before parking began", async () => {
    const order: string[] = [];
    mocks.listParkingCandidates.mockResolvedValue([
      {
        clarificationId: "clar-1",
        subjectKey: "ticket:jira:AWT-1",
        ownerToken: "owner-predecessor",
        runId: "run-predecessor",
      },
    ]);
    mocks.getRun.mockReturnValue({ status: Promise.resolve("failed") });
    const registry = {
      get: vi.fn().mockResolvedValue({
        subjectKey: "ticket:jira:AWT-1",
        ownerToken: "owner-predecessor",
        runId: "run-predecessor",
        state: "bound",
      }),
      beginParking: vi.fn(async () => {
        order.push("begin");
        return true;
      }),
      listSandboxes: vi.fn(async () => {
        order.push("list");
        return ["sbx-1"];
      }),
      finishParking: vi.fn(async () => {
        order.push("finish");
        return true;
      }),
    } as never;
    mocks.stopSandboxes.mockImplementation(async () => {
      order.push("stop");
      return 1;
    });

    await expect(
      recoverInterruptedClarificationParking({ db, runRegistry: registry }),
    ).resolves.toBe(1);
    expect(mocks.getRun).toHaveBeenCalledWith("run-predecessor");
    expect(mocks.listWorkflowSteps).toHaveBeenCalledWith({
      runId: "run-predecessor",
      resolveData: "none",
      pagination: { limit: 100 },
    });
    expect(order).toEqual(["begin", "list", "stop", "finish"]);
  });

  it("keeps a terminal bound predecessor until its already-running Workflow step drains", async () => {
    mocks.listParkingCandidates.mockResolvedValue([
      {
        clarificationId: "clar-1",
        subjectKey: "ticket:jira:AWT-1",
        ownerToken: "owner-predecessor",
        runId: "run-predecessor",
      },
    ]);
    mocks.getRun.mockReturnValue({ status: Promise.resolve("completed") });
    mocks.listWorkflowSteps.mockResolvedValue({
      data: [{ status: "running" }],
      cursor: null,
      hasMore: false,
    });
    const beginParking = vi.fn();
    const registry = {
      get: vi.fn().mockResolvedValue({
        subjectKey: "ticket:jira:AWT-1",
        ownerToken: "owner-predecessor",
        runId: "run-predecessor",
        state: "bound",
      }),
      beginParking,
    } as never;

    await expect(
      recoverInterruptedClarificationParking({ db, runRegistry: registry }),
    ).resolves.toBe(0);
    expect(beginParking).not.toHaveBeenCalled();
  });

  it("checks every Workflow step page before parking a terminal bound predecessor", async () => {
    mocks.listParkingCandidates.mockResolvedValue([
      {
        clarificationId: "clar-1",
        subjectKey: "ticket:jira:AWT-1",
        ownerToken: "owner-predecessor",
        runId: "run-predecessor",
      },
    ]);
    mocks.getRun.mockReturnValue({ status: Promise.resolve("completed") });
    mocks.listWorkflowSteps
      .mockResolvedValueOnce({ data: [], cursor: "page-2", hasMore: true })
      .mockResolvedValueOnce({ data: [], cursor: null, hasMore: false });
    const registry = {
      get: vi.fn().mockResolvedValue({
        subjectKey: "ticket:jira:AWT-1",
        ownerToken: "owner-predecessor",
        runId: "run-predecessor",
        state: "bound",
      }),
      beginParking: vi.fn().mockResolvedValue(true),
      listSandboxes: vi.fn().mockResolvedValue([]),
      finishParking: vi.fn().mockResolvedValue(true),
    } as never;

    await expect(
      recoverInterruptedClarificationParking({ db, runRegistry: registry }),
    ).resolves.toBe(1);
    expect(mocks.listWorkflowSteps).toHaveBeenNthCalledWith(2, {
      runId: "run-predecessor",
      resolveData: "none",
      pagination: { limit: 100, cursor: "page-2" },
    });
  });

  it("does not park a bound clarification while its workflow is still running", async () => {
    mocks.listParkingCandidates.mockResolvedValue([
      {
        clarificationId: "clar-1",
        subjectKey: "ticket:jira:AWT-1",
        ownerToken: "owner-predecessor",
        runId: "run-predecessor",
      },
    ]);
    const beginParking = vi.fn();
    const registry = {
      get: vi.fn().mockResolvedValue({
        subjectKey: "ticket:jira:AWT-1",
        ownerToken: "owner-predecessor",
        runId: "run-predecessor",
        state: "bound",
      }),
      beginParking,
    } as never;

    await expect(
      recoverInterruptedClarificationParking({ db, runRegistry: registry }),
    ).resolves.toBe(0);
    expect(beginParking).not.toHaveBeenCalled();
  });

  it("retries an already-started parking transition without a workflow status read", async () => {
    mocks.listParkingCandidates.mockResolvedValue([
      {
        clarificationId: "clar-1",
        subjectKey: "ticket:jira:AWT-1",
        ownerToken: "owner-predecessor",
        runId: "run-predecessor",
      },
    ]);
    const registry = {
      get: vi.fn().mockResolvedValue({
        subjectKey: "ticket:jira:AWT-1",
        ownerToken: "owner-predecessor",
        runId: "run-predecessor",
        state: "parking",
      }),
      beginParking: vi.fn().mockResolvedValue(true),
      listSandboxes: vi.fn().mockResolvedValue([]),
      finishParking: vi.fn().mockResolvedValue(true),
    } as never;

    await expect(
      recoverInterruptedClarificationParking({ db, runRegistry: registry }),
    ).resolves.toBe(1);
    expect(mocks.getRun).not.toHaveBeenCalled();
  });

  it("keeps the owner in parking when sandbox termination is unconfirmed", async () => {
    mocks.listParkingCandidates.mockResolvedValue([
      {
        clarificationId: "clar-1",
        subjectKey: "ticket:jira:AWT-1",
        ownerToken: "owner-predecessor",
        runId: "run-predecessor",
      },
    ]);
    const finishParking = vi.fn();
    const registry = {
      get: vi.fn().mockResolvedValue({
        subjectKey: "ticket:jira:AWT-1",
        ownerToken: "owner-predecessor",
        runId: "run-predecessor",
        state: "parking",
      }),
      beginParking: vi.fn().mockResolvedValue(true),
      listSandboxes: vi.fn().mockResolvedValue(["sbx-1"]),
      finishParking,
    } as never;
    mocks.stopSandboxes.mockRejectedValue(new Error("provider unavailable"));

    await expect(
      recoverInterruptedClarificationParking({ db, runRegistry: registry }),
    ).resolves.toBe(0);
    expect(finishParking).not.toHaveBeenCalled();
  });

  it("retries answered checkpoints and records the one winning successor run", async () => {
    const checkpoint = {
      id: "clar-1",
      runId: "run-parked",
      answer: "keep ours",
      answeredById: "user-1",
      answeredByLabel: "Alice",
    };
    mocks.listUndispatched.mockResolvedValue([checkpoint]);
    mocks.dispatchAnswered.mockResolvedValue({ status: "started", runId: "run-next" });

    expect(
      await recoverUndispatchedClarificationSuccessors({
        db,
        runRegistry,
        issueTracker,
        maxConcurrentAgents: 3,
      }),
    ).toBe(1);
    expect(mocks.dispatchAnswered).toHaveBeenCalledWith(
      expect.objectContaining({
        clarification: checkpoint,
        answer: "keep ours",
        actor: { id: "user-1", label: "Alice" },
        isRetry: true,
      }),
    );
    expect(mocks.resolveAwaitingRun).not.toHaveBeenCalled();
  });

  it("starts a durable workflow that owns cleanup claiming internally", async () => {
    const candidate = { clarificationId: "clar-1", snapshotId: "snap-1" };
    mocks.listCleanup.mockResolvedValue([candidate]);

    expect(await startQueuedClarificationSnapshotCleanups({ db })).toBe(1);
    expect(mocks.claimCleanup).not.toHaveBeenCalled();
    expect(mocks.start).toHaveBeenCalledWith(expect.any(Function), [candidate]);
  });

  it("returns a failed start to the retry queue", async () => {
    const candidate = { clarificationId: "clar-1", snapshotId: "snap-1" };
    mocks.listCleanup.mockResolvedValue([candidate]);
    mocks.start.mockRejectedValue(new Error("start failed"));

    expect(await startQueuedClarificationSnapshotCleanups({ db })).toBe(0);
    expect(mocks.markCleanupFailed).toHaveBeenCalledWith(db, "clar-1", "start failed");
  });
});
