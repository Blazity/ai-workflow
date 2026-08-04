import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveRunEntry, RunRegistryAdapter } from "../adapters/run-registry/types.js";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";

const state = vi.hoisted(() => ({
  getRun: vi.fn(),
  listSteps: vi.fn(),
  stopSandboxes: vi.fn(),
  tombstone: vi.fn(),
  retireApproval: vi.fn(),
  moveTicket: vi.fn(),
  recordStatusReason: vi.fn(),
  markBlockedOnCancel: vi.fn(),
}));

vi.mock("workflow/api", () => ({ getRun: state.getRun }));
vi.mock("workflow/runtime", () => ({
  getWorld: () => ({ steps: { list: state.listSteps } }),
}));
vi.mock("../sandbox/stop-ticket-sandboxes.js", () => ({
  stopSandboxesByIds: state.stopSandboxes,
}));
vi.mock("../db/client.js", () => ({ getDb: () => ({ db: true }) }));
vi.mock("../clarifications/store.js", () => ({
  tombstoneClarificationCancellation: state.tombstone,
}));
vi.mock("../approvals/store.js", () => ({
  retireApprovalCancellation: state.retireApproval,
}));
vi.mock("./ticket-transition.js", () => ({ moveTicketForRun: state.moveTicket }));
vi.mock("./telemetry/run-telemetry.js", () => ({
  recordRunStatusReason: state.recordStatusReason,
  markRunBlockedOnCancel: state.markBlockedOnCancel,
}));

import { cancelRun, cancelRunDetailed } from "./cancel-run.js";

function active(overrides: Partial<ActiveRunEntry> = {}): ActiveRunEntry {
  return {
    subjectKey: "ticket:jira:PROJ-1",
    ticketKey: "PROJ-1",
    ownerToken: "owner-a",
    runId: "run-1",
    state: "bound",
    kind: "ticket",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function registry(entry: ActiveRunEntry | null = active()): RunRegistryAdapter {
  return {
    reserve: vi.fn(),
    commitStartedRun: vi.fn(),
    markRunEntryStarted: vi.fn(),
    bindRun: vi.fn(),
    beginParking: vi.fn(),
    finishParking: vi.fn(),
    handoff: vi.fn(),
    get: vi.fn().mockResolvedValue(entry),
    beginCancellation: vi.fn().mockResolvedValue(true),
    releaseCancellation: vi.fn().mockResolvedValue(true),
    releaseReservation: vi.fn(),
    release: vi.fn(),
    listAll: vi.fn(),
    registerSandbox: vi.fn(),
    listSandboxes: vi.fn().mockResolvedValue(["sandbox-1"]),
    markFailed: vi.fn(),
    isTicketFailed: vi.fn(),
    listAllFailed: vi.fn(),
    clearFailedMark: vi.fn(),
  };
}

describe("cancelRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.getRun.mockReturnValue({ cancel: vi.fn().mockResolvedValue(undefined) });
    state.listSteps.mockResolvedValue({ data: [], cursor: null, hasMore: false });
    state.stopSandboxes.mockResolvedValue(undefined);
    state.tombstone.mockResolvedValue({ matched: false, successorOwnerToken: null });
    state.retireApproval.mockResolvedValue(0);
    state.moveTicket.mockResolvedValue(undefined);
    state.recordStatusReason.mockResolvedValue(undefined);
    state.markBlockedOnCancel.mockResolvedValue(undefined);
  });

  it("closes, cancels, drains, cleans, and releases the exact owner", async () => {
    const runRegistry = registry();
    await expect(cancelRun(
      "PROJ-1",
      { ownerToken: "owner-a", runId: "run-1" },
      runRegistry,
    )).resolves.toBe(true);

    expect(runRegistry.beginCancellation).toHaveBeenCalledWith(
      "ticket:jira:PROJ-1",
      "owner-a",
      "run-1",
    );
    expect(state.stopSandboxes).toHaveBeenCalledWith(["sandbox-1"]);
    expect(runRegistry.releaseCancellation).toHaveBeenCalledWith(
      "ticket:jira:PROJ-1",
      "owner-a",
      "run-1",
    );
  });

  it("does not cancel a different owner", async () => {
    const runRegistry = registry();
    await expect(cancelRun(
      "PROJ-1",
      { ownerToken: "foreign", runId: "run-1" },
      runRegistry,
    )).resolves.toBe(false);
    expect(runRegistry.beginCancellation).not.toHaveBeenCalled();
  });

  it("retains ownership when Workflow cancellation cannot be confirmed", async () => {
    state.getRun.mockReturnValue({
      cancel: vi.fn().mockRejectedValue(new Error("unreachable")),
      status: Promise.resolve("running"),
    });
    const runRegistry = registry();
    await expect(cancelRun(
      "PROJ-1",
      { ownerToken: "owner-a", runId: "run-1" },
      runRegistry,
    )).resolves.toBe(false);
    expect(runRegistry.releaseCancellation).not.toHaveBeenCalled();
  });

  it("reports the already-terminal outcome and still releases the claim when the run had already failed", async () => {
    state.getRun.mockReturnValue({
      cancel: vi.fn().mockRejectedValue(new Error("run already terminal")),
      status: Promise.resolve("failed"),
    });
    const runRegistry = registry();
    await expect(cancelRunDetailed(
      "PROJ-1",
      { ownerToken: "owner-a", runId: "run-1" },
      runRegistry,
    )).resolves.toEqual({ cancelled: true, released: true, alreadyTerminal: true });
    expect(runRegistry.releaseCancellation).toHaveBeenCalledWith(
      "ticket:jira:PROJ-1",
      "owner-a",
      "run-1",
    );
  });

  it("performs a compatibility ticket move under the cancelling owner", async () => {
    const runRegistry = registry();
    const issueTracker = { moveTicket: vi.fn() } as unknown as IssueTrackerAdapter;
    await expect(cancelRun(
      "PROJ-1",
      { ownerToken: "owner-a", runId: "run-1" },
      runRegistry,
      issueTracker,
      "Backlog",
    )).resolves.toBe(true);
    expect(state.moveTicket).toHaveBeenCalledWith({
      db: { db: true },
      issueTracker,
      ticketKey: "PROJ-1",
      target: "Backlog",
      owner: expect.objectContaining({
        subjectKey: "ticket:jira:PROJ-1",
        ownerToken: "owner-a",
        runId: "run-1",
      }),
      requiredOwnerState: "cancelling",
    });
  });

  it("records the cancellation reason best-effort after a confirmed cancel", async () => {
    const runRegistry = registry();
    await expect(cancelRun(
      "PROJ-1",
      { ownerToken: "owner-a", runId: "run-1" },
      runRegistry,
      undefined,
      undefined,
      undefined,
      "Cancelled via Slack /ai-workflow cancel",
    )).resolves.toBe(true);
    expect(state.recordStatusReason).toHaveBeenCalledWith(
      { db: true },
      "run-1",
      "Cancelled via Slack /ai-workflow cancel",
      { kind: "cancellation" },
    );
  });

  it("skips the reason write when none is given", async () => {
    const runRegistry = registry();
    await expect(cancelRun(
      "PROJ-1",
      { ownerToken: "owner-a", runId: "run-1" },
      runRegistry,
    )).resolves.toBe(true);
    expect(state.recordStatusReason).not.toHaveBeenCalled();
  });

  it("still confirms cancellation when the reason write fails", async () => {
    state.recordStatusReason.mockRejectedValue(new Error("db down"));
    const runRegistry = registry();
    await expect(cancelRun(
      "PROJ-1",
      { ownerToken: "owner-a", runId: "run-1" },
      runRegistry,
      undefined,
      undefined,
      undefined,
      "reason",
    )).resolves.toBe(true);
    expect(runRegistry.releaseCancellation).toHaveBeenCalled();
  });

  // A run cancelled while it was parked on a clarification never resumes to
  // clear the live "awaiting" the park wrote, so cancellation settles it.
  it("settles a parked run as blocked after a confirmed cancel", async () => {
    const runRegistry = registry({ ...active(), state: "parked" });
    await expect(cancelRun(
      "PROJ-1",
      { ownerToken: "owner-a", runId: "run-1" },
      runRegistry,
    )).resolves.toBe(true);
    expect(state.markBlockedOnCancel).toHaveBeenCalledWith({ db: true }, "run-1");
  });

  // Cancelling wakes the parked body, whose own error path flips the run back to
  // "running". The settle has to land after the step drain proves that body can
  // no longer write, or that flip wins and the cancelled run reads as in flight.
  it("settles the park only after the step drain barrier", async () => {
    const runRegistry = registry({ ...active(), state: "parked" });
    await expect(cancelRun(
      "PROJ-1",
      { ownerToken: "owner-a", runId: "run-1" },
      runRegistry,
    )).resolves.toBe(true);
    const drained = Math.max(...state.listSteps.mock.invocationCallOrder);
    expect(state.markBlockedOnCancel.mock.invocationCallOrder[0]).toBeGreaterThan(
      drained,
    );
  });

  it("still confirms cancellation when the awaiting settle fails", async () => {
    state.markBlockedOnCancel.mockRejectedValue(new Error("db down"));
    const runRegistry = registry({ ...active(), state: "parked" });
    await expect(cancelRun(
      "PROJ-1",
      { ownerToken: "owner-a", runId: "run-1" },
      runRegistry,
    )).resolves.toBe(true);
    expect(runRegistry.releaseCancellation).toHaveBeenCalled();
  });
});
