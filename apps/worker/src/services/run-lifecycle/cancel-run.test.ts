import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettingsSnapshot } from "@shared/contracts";
import type { ActiveRunEntry, RunRegistryAdapter } from "../../adapters/run-registry/types.js";
import type { IssueTrackerAdapter } from "../../adapters/issue-tracker/types.js";
import type { Db } from "../../db/client.js";

const state = vi.hoisted(() => ({
  getRun: vi.fn(),
  listSteps: vi.fn(),
  stopSandboxes: vi.fn(),
  tombstone: vi.fn(),
  retireApproval: vi.fn(),
  moveTicket: vi.fn(),
  recordStatusReason: vi.fn(),
  markBlockedOnCancel: vi.fn(),
  markBlockedByOperator: vi.fn(),
  findLiveClaim: vi.fn(),
  findRunOutcome: vi.fn(),
  settleOccurrence: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../infra/vcs-config.js", () => ({
  env: {
    COLUMN_AI: "AI",
    COLUMN_BACKLOG: "Backlog",
    JIRA_BACKLOG_TRANSITION_ID: undefined,
  },
}));

vi.mock("workflow/api", () => ({ getRun: state.getRun }));
vi.mock("workflow/runtime", () => ({
  getWorld: () => ({ steps: { list: state.listSteps } }),
}));
vi.mock("../../sandbox/stop-ticket-sandboxes.js", () => ({
  stopSandboxesByIds: state.stopSandboxes,
}));
vi.mock("../../db/client.js", () => ({ getDb: () => ({ db: true }) }));
vi.mock("../../db/repositories/clarifications.js", () => ({
  tombstoneConnectedClarificationCancellation: state.tombstone,
}));
vi.mock("../../db/repositories/approvals.js", () => ({
  retireConnectedApprovalCancellation: state.retireApproval,
}));
vi.mock("../tickets/ticket-transition.js", () => ({
  moveConnectedTicketForRun: state.moveTicket,
  withdrawConnectedTicketFromAiForRun: state.moveTicket,
}));
vi.mock("../../db/repositories/runs/telemetry.js", () => ({
  recordConnectedRunStatusReason: state.recordStatusReason,
  markConnectedRunBlockedOnCancel: state.markBlockedOnCancel,
  markConnectedRunBlockedByOperator: state.markBlockedByOperator,
}));
vi.mock("../../db/repositories/runs.js", () => ({
  findConnectedLiveRunClaimByRunId: state.findLiveClaim,
  findConnectedRunOutcomeByRunId: state.findRunOutcome,
}));
// cancelRunForOperator reaches the schedule ledger through a dynamic import, so this
// mock has to stand in for the whole module rather than one export of it.
vi.mock("../../db/repositories/schedule-triggers.js", () => ({
  settleConnectedScheduleOccurrenceOnCancel: state.settleOccurrence,
}));
vi.mock("../../infra/logger.js", () => ({
  logger: { warn: state.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  cancelRun,
  cancelRunById,
  cancelRunDetailed,
  cancelRunForOperator,
} from "./cancel-run.js";

const cancelSettings = defaultSettingsSnapshot();

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
    release: vi.fn().mockResolvedValue(true),
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
    )).resolves.toEqual({
      cancelled: true,
      released: true,
      alreadyTerminal: true,
      tornDown: true,
    });
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

  it("runs an explicit final fence before releasing the cancelling owner", async () => {
    const runRegistry = registry();
    const beforeRelease = vi.fn().mockResolvedValue(undefined);

    await expect(cancelRunDetailed(
      "PROJ-1",
      { ownerToken: "owner-a", runId: "run-1" },
      runRegistry,
      undefined,
      undefined,
      undefined,
      undefined,
      beforeRelease,
    )).resolves.toMatchObject({ cancelled: true, released: true });

    expect(beforeRelease).toHaveBeenCalledWith(expect.objectContaining({
      subjectKey: "ticket:jira:PROJ-1",
      ownerToken: "owner-a",
      runId: "run-1",
    }));
    expect(beforeRelease.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runRegistry.releaseCancellation).mock.invocationCallOrder[0],
    );
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
    expect(state.markBlockedOnCancel).toHaveBeenCalledWith("run-1");
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

describe("cancelRunById", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.getRun.mockReturnValue({ cancel: vi.fn().mockResolvedValue(undefined) });
    state.listSteps.mockResolvedValue({ data: [], cursor: null, hasMore: false });
    state.stopSandboxes.mockResolvedValue(undefined);
    state.tombstone.mockResolvedValue({ matched: false, successorOwnerToken: null });
    state.retireApproval.mockResolvedValue(0);
    // A ticket withdrawal is now reachable from two paths here, and clearAllMocks
    // keeps implementations, so the default has to be restored per test.
    state.moveTicket.mockResolvedValue(undefined);
    state.recordStatusReason.mockResolvedValue(undefined);
    state.markBlockedOnCancel.mockResolvedValue(undefined);
    state.markBlockedByOperator.mockResolvedValue(undefined);
    state.findLiveClaim.mockResolvedValue(null);
    state.findRunOutcome.mockResolvedValue(null);
  });

  // A schedule/webhook run has no ticket, so it is addressed only by run id.
  const scheduleClaim = (over: Partial<ActiveRunEntry> = {}): ActiveRunEntry =>
    active({ subjectKey: "sched:demo:hourly", ticketKey: null, kind: "schedule", ...over });

  // Compatibility callers retain the explicit Db argument while production
  // paths use the connected repository operations.
  const outerDb = { marker: "outer" } as unknown as Db;

  it("cancels a live run: settles blocked with the operator reason and releases the subject", async () => {
    state.findLiveClaim.mockResolvedValue({
      subjectKey: "sched:demo:hourly",
      ownerToken: "owner-a",
    });
    const runRegistry = registry(scheduleClaim());
    const db = outerDb;

    await expect(
      cancelRunById(db, "run-1", {
        actorLabel: "operator kate",
        runRegistry,
        settings: cancelSettings,
      }),
    ).resolves.toEqual({ outcome: "cancelled", subjectKey: "sched:demo:hourly" });

    // Reuses the subject cancel core against the exact owner from active_runs.
    expect(runRegistry.beginCancellation).toHaveBeenCalledWith(
      "sched:demo:hourly",
      "owner-a",
      "run-1",
    );
    // Releasing the subject is what lets a schedule/webhook blocked behind the
    // run resume once the run is gone.
    expect(runRegistry.releaseCancellation).toHaveBeenCalledWith(
      "sched:demo:hourly",
      "owner-a",
      "run-1",
    );
    // Synchronous blocked + reason via the operator-only writer (the 3-arg call),
    // never the park writer settleCancelledPark drives.
    expect(state.markBlockedByOperator).toHaveBeenCalledWith(
      "run-1",
      "cancelled by operator kate",
    );
  });

  it("withdraws a cancelled manual ticket before releasing its claim", async () => {
    state.findLiveClaim.mockResolvedValue({
      subjectKey: "ticket:jira:PROJ-1",
      ticketKey: "PROJ-1",
      ownerToken: "owner-a",
      kind: "manual_ticket",
    });
    const runRegistry = registry(active({ kind: "manual_ticket" }));
    const issueTracker = {} as IssueTrackerAdapter;

    await expect(
      cancelRunById(outerDb, "run-1", {
        actorLabel: "operator kate",
        runRegistry,
        issueTracker,
        settings: cancelSettings,
      }),
    ).resolves.toEqual({
      outcome: "cancelled",
      subjectKey: "ticket:jira:PROJ-1",
    });
    expect(state.moveTicket).toHaveBeenCalledWith({
      issueTracker,
      ticketKey: "PROJ-1",
      aiColumn: expect.any(String),
      target: expect.any(String),
      owner: expect.objectContaining({
        subjectKey: "ticket:jira:PROJ-1",
        ownerToken: "owner-a",
        runId: "run-1",
      }),
      requiredOwnerState: "cancelling",
    });
    expect(state.moveTicket.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runRegistry.releaseCancellation).mock.invocationCallOrder[0]!,
    );
  });

  // The irreversible cancel already landed and the claim is released, so a
  // transient settle failure must never surface as a throw (E4 would map it to
  // 500) or flip the outcome; the cron backstops the row, like the park sibling.
  it("still reports cancelled when the operator settle write fails after the cancel", async () => {
    state.findLiveClaim.mockResolvedValue({
      subjectKey: "sched:demo:hourly",
      ownerToken: "owner-a",
    });
    state.markBlockedByOperator.mockRejectedValue(new Error("neon blip"));
    const runRegistry = registry(scheduleClaim());

    await expect(
      cancelRunById(outerDb, "run-1", {
        actorLabel: "operator kate",
        runRegistry,
        settings: cancelSettings,
      }),
    ).resolves.toEqual({ outcome: "cancelled", subjectKey: "sched:demo:hourly" });

    expect(state.markBlockedByOperator).toHaveBeenCalled();
    expect(runRegistry.releaseCancellation).toHaveBeenCalled();
  });

  // Observed on prod: the Workflow run was cancelled mid-step, so the step drain
  // never confirms. The run is dead, so "try again" is a lie and the schedule
  // ledger (settled by the route on outcome "cancelled") would never flip.
  it("reports cancelled when the run is torn down but the step drain cannot be confirmed", async () => {
    state.listSteps.mockResolvedValue({
      data: [{ status: "running" }],
      cursor: null,
      hasMore: false,
    });
    state.findLiveClaim.mockResolvedValue({
      subjectKey: "sched:demo:hourly",
      ownerToken: "owner-a",
    });
    const runRegistry = registry(scheduleClaim());

    await expect(
      cancelRunById(outerDb, "run-1", {
        actorLabel: "operator kate",
        runRegistry,
        settings: cancelSettings,
      }),
    ).resolves.toEqual({ outcome: "cancelled", subjectKey: "sched:demo:hourly" });

    expect(state.markBlockedByOperator).toHaveBeenCalledWith(
      "run-1",
      "cancelled by operator kate",
    );
    // This path deliberately leaves the claim in "cancelling" for reconcileRuns
    // to converge on the poll cron (retryCancellingClaim); nothing here
    // force-releases it.
    expect(runRegistry.releaseCancellation).not.toHaveBeenCalled();
  });

  // Same shape one step earlier: the sandbox cleanup throws after the Workflow
  // run is already gone. The teardown is still irreversible.
  it("reports cancelled when sandbox cleanup fails after the run is torn down", async () => {
    state.stopSandboxes.mockRejectedValue(new Error("sandbox api down"));
    state.findLiveClaim.mockResolvedValue({
      subjectKey: "sched:demo:hourly",
      ownerToken: "owner-a",
    });
    const runRegistry = registry(scheduleClaim());

    await expect(
      cancelRunById(outerDb, "run-1", {
        actorLabel: "operator kate",
        runRegistry,
        settings: cancelSettings,
      }),
    ).resolves.toEqual({ outcome: "cancelled", subjectKey: "sched:demo:hourly" });

    expect(state.markBlockedByOperator).toHaveBeenCalled();
  });

  it("reports already_terminal without writing status when only Workflow knows the run finished", async () => {
    // workflow_runs lags the registry here, so the store status is no proof and the
    // full cancel path runs: Workflow reports the run terminal, and the claim is
    // released through the cancellation primitive that path uses.
    state.getRun.mockReturnValue({
      cancel: vi.fn().mockRejectedValue(new Error("run already terminal")),
      status: Promise.resolve("failed"),
    });
    state.findLiveClaim.mockResolvedValue({
      subjectKey: "sched:demo:hourly",
      ownerToken: "owner-a",
    });
    state.findRunOutcome.mockResolvedValue({ status: "running" });
    const runRegistry = registry(scheduleClaim());

    await expect(
      cancelRunById(outerDb, "run-1", {
        actorLabel: "operator kate",
        runRegistry,
        settings: cancelSettings,
      }),
    ).resolves.toEqual({
      outcome: "already_terminal",
      subjectKey: "sched:demo:hourly",
      status: "running",
    });

    // Invariant 2: no status write for an already-terminal run.
    expect(state.markBlockedByOperator).not.toHaveBeenCalled();
    // The lingering claim is still released so a blocked schedule/webhook resumes.
    expect(runRegistry.releaseCancellation).toHaveBeenCalled();
  });

  /** Workflow's own verdict that the run will not advance again, which a store
   * status alone never proves: markRunSucceededOnSelfMove writes "success" while
   * the run is still moving the ticket and notifying. */
  const workflowTerminal = (status = "completed") => {
    state.getRun.mockReturnValue({
      cancel: vi.fn().mockRejectedValue(new Error("never called by the shortcut")),
      status: Promise.resolve(status),
    });
  };

  // A run that finished on its own leaves its claim behind whenever nothing
  // releases it (the engine-canary target runs no reconciler cron). Cancelling it
  // must free the subject and report the recorded outcome instead of reading the
  // leftover claim as liveness, which is what answered CONFLICT on 2026-09-14.
  it("releases a lingering claim and reports already_terminal for a finished run", async () => {
    workflowTerminal();
    state.findLiveClaim.mockResolvedValue({
      subjectKey: "sched:demo:hourly",
      ownerToken: "owner-a",
    });
    state.findRunOutcome.mockResolvedValue({ status: "success" });
    const runRegistry = registry(scheduleClaim());

    await expect(
      cancelRunById(outerDb, "run-1", {
        actorLabel: "MCP canary",
        runRegistry,
        settings: cancelSettings,
      }),
    ).resolves.toEqual({
      outcome: "already_terminal",
      subjectKey: "sched:demo:hourly",
      status: "success",
    });

    // Workflow is asked whether the run is really over, and never asked to cancel.
    expect(state.getRun).toHaveBeenCalledWith("run-1");
    // The reconciler's terminal order: stop the owned sandboxes, then release.
    expect(state.stopSandboxes).toHaveBeenCalledWith(["sandbox-1"]);
    expect(runRegistry.release).toHaveBeenCalledWith(
      "sched:demo:hourly",
      "owner-a",
      "run-1",
    );
    expect(state.stopSandboxes.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runRegistry.release).mock.invocationCallOrder[0]!,
    );
    // No status write anywhere: the run keeps the outcome it reached on its own.
    expect(state.markBlockedByOperator).not.toHaveBeenCalled();
    expect(state.markBlockedOnCancel).not.toHaveBeenCalled();
    expect(state.recordStatusReason).not.toHaveBeenCalled();
    // No cancellation: the claim is never closed and no clarification is retired.
    expect(runRegistry.beginCancellation).not.toHaveBeenCalled();
    expect(state.tombstone).not.toHaveBeenCalled();
  });

  // The blocker the gate caught: "success" is committed mid-run, before the
  // self-move of the ticket and everything after it. A store status is therefore
  // never liveness proof on its own, and only Workflow can retire the run.
  it("does not release a claim while Workflow still reports the run running", async () => {
    state.getRun.mockReturnValue({
      cancel: vi.fn().mockResolvedValue(undefined),
      status: Promise.resolve("running"),
    });
    state.findLiveClaim.mockResolvedValue({
      subjectKey: "sched:demo:hourly",
      ownerToken: "owner-a",
    });
    state.findRunOutcome.mockResolvedValue({ status: "success" });
    const runRegistry = registry(scheduleClaim());

    await expect(
      cancelRunById(outerDb, "run-1", {
        actorLabel: "operator kate",
        runRegistry,
        settings: cancelSettings,
      }),
    ).resolves.toEqual({ outcome: "cancelled", subjectKey: "sched:demo:hourly" });

    // Today's behaviour, unchanged: the full teardown and the operator status write.
    expect(runRegistry.release).not.toHaveBeenCalled();
    expect(runRegistry.beginCancellation).toHaveBeenCalled();
    expect(state.markBlockedByOperator).toHaveBeenCalledWith(
      "run-1",
      "cancelled by operator kate",
    );
  });

  // The step drain stays the second barrier: a Workflow run can be terminal while
  // a handler that started before it went terminal is still executing.
  it("does not release a lingering claim while a step of the run is still running", async () => {
    workflowTerminal();
    state.listSteps.mockResolvedValue({
      data: [{ status: "running" }],
      cursor: null,
      hasMore: false,
    });
    state.findLiveClaim.mockResolvedValue({
      subjectKey: "sched:demo:hourly",
      ownerToken: "owner-a",
    });
    state.findRunOutcome.mockResolvedValue({ status: "success" });
    const runRegistry = registry(scheduleClaim());

    await cancelRunById(outerDb, "run-1", {
      actorLabel: "operator kate",
      runRegistry,
      settings: cancelSettings,
    });

    expect(runRegistry.release).not.toHaveBeenCalled();
  });

  // Brief invariant 4: a run whose liveness cannot be established still answers
  // CONFLICT, terminal store status or not.
  it("still reports unconfirmed when Workflow cannot be reached at all", async () => {
    state.getRun.mockReturnValue({
      cancel: vi.fn().mockRejectedValue(new Error("unreachable")),
      get status() {
        return Promise.reject(new Error("unreachable"));
      },
    });
    state.findLiveClaim.mockResolvedValue({
      subjectKey: "sched:demo:hourly",
      ownerToken: "owner-a",
    });
    state.findRunOutcome.mockResolvedValue({ status: "success" });
    const runRegistry = registry(scheduleClaim());

    await expect(
      cancelRunById(outerDb, "run-1", {
        actorLabel: "operator kate",
        runRegistry,
        settings: cancelSettings,
      }),
    ).resolves.toEqual({ outcome: "unconfirmed", subjectKey: "sched:demo:hourly" });

    expect(runRegistry.release).not.toHaveBeenCalled();
    expect(state.markBlockedByOperator).not.toHaveBeenCalled();
  });

  // Releasing a claim while the run's sandboxes are still up would strand them,
  // so the stop is a precondition of the release, exactly as in the reconciler.
  it("does not release a lingering claim when the sandbox stop fails", async () => {
    workflowTerminal();
    state.stopSandboxes.mockRejectedValue(new Error("sandbox api down"));
    state.findLiveClaim.mockResolvedValue({
      subjectKey: "sched:demo:hourly",
      ownerToken: "owner-a",
    });
    state.findRunOutcome.mockResolvedValue({ status: "success" });
    const runRegistry = registry(scheduleClaim());

    await cancelRunById(outerDb, "run-1", {
      actorLabel: "operator kate",
      runRegistry,
      settings: cancelSettings,
    });

    expect(runRegistry.release).not.toHaveBeenCalled();
    expect(runRegistry.beginCancellation).toHaveBeenCalled();
  });

  // A manual ticket uses the Ai column as execution state. Releasing its claim
  // while the ticket is still in Ai is what let the poll dispatch a stray run on
  // the canary fixture 15 minutes later, so the shortcut applies the same
  // withdrawal the full cancel path applies, before the release.
  it("withdraws a finished manual ticket from Ai before releasing its claim", async () => {
    workflowTerminal();
    state.findLiveClaim.mockResolvedValue({
      subjectKey: "ticket:jira:PROJ-1",
      ticketKey: "PROJ-1",
      ownerToken: "owner-a",
      kind: "manual_ticket",
    });
    state.findRunOutcome.mockResolvedValue({ status: "success" });
    const runRegistry = registry(active({ kind: "manual_ticket" }));
    const issueTracker = {} as IssueTrackerAdapter;

    await expect(
      cancelRunById(outerDb, "run-1", {
        actorLabel: "MCP canary",
        runRegistry,
        issueTracker,
        settings: cancelSettings,
      }),
    ).resolves.toEqual({
      outcome: "already_terminal",
      subjectKey: "ticket:jira:PROJ-1",
      status: "success",
    });

    expect(state.moveTicket).toHaveBeenCalledWith({
      issueTracker,
      ticketKey: "PROJ-1",
      aiColumn: expect.any(String),
      target: expect.any(String),
      owner: expect.objectContaining({
        subjectKey: "ticket:jira:PROJ-1",
        ownerToken: "owner-a",
        runId: "run-1",
      }),
      // The claim was never closed, so the fence is the bound owner, not cancelling.
      requiredOwnerState: "bound",
    });
    // The reconciler's order for a finished ticket run (cleanFinishedManualTicket):
    // withdraw the ticket, stop the sandboxes, then release.
    expect(state.moveTicket.mock.invocationCallOrder[0]).toBeLessThan(
      state.stopSandboxes.mock.invocationCallOrder[0]!,
    );
    expect(state.stopSandboxes.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runRegistry.release).mock.invocationCallOrder[0]!,
    );
    expect(state.markBlockedByOperator).not.toHaveBeenCalled();
  });

  // A poll-dispatched ticket run reaches the same state: terminal, claim left
  // behind, ticket still in Ai because the graph never moved it. Releasing that
  // claim without the withdrawal hands the very next poll a ticket in Ai with no
  // owner, which it dispatches as new work. The withdrawal is a no-op for a run
  // that did move its ticket (ticket-transition.test.ts, "preserves a
  // workflow-selected destination outside AI").
  it("withdraws a finished poll-dispatched ticket from Ai before releasing its claim", async () => {
    workflowTerminal();
    state.findLiveClaim.mockResolvedValue({
      subjectKey: "ticket:jira:PROJ-1",
      ticketKey: "PROJ-1",
      ownerToken: "owner-a",
      kind: "ticket",
    });
    state.findRunOutcome.mockResolvedValue({ status: "success" });
    const runRegistry = registry(active({ kind: "ticket" }));
    const issueTracker = {} as IssueTrackerAdapter;

    await expect(
      cancelRunById(outerDb, "run-1", {
        actorLabel: "MCP canary",
        runRegistry,
        issueTracker,
        settings: cancelSettings,
      }),
    ).resolves.toEqual({
      outcome: "already_terminal",
      subjectKey: "ticket:jira:PROJ-1",
      status: "success",
    });

    expect(state.moveTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketKey: "PROJ-1",
        requiredOwnerState: "bound",
      }),
    );
    expect(state.moveTicket.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runRegistry.release).mock.invocationCallOrder[0]!,
    );
  });

  // Enumerating the run's children is a precondition of stopping them, so a
  // lookup that fails must not be read as "there were none".
  it("does not release a lingering claim when the sandbox lookup fails", async () => {
    workflowTerminal();
    const runRegistry = registry(scheduleClaim());
    vi.mocked(runRegistry.listSandboxes).mockRejectedValue(new Error("registry down"));
    state.findLiveClaim.mockResolvedValue({
      subjectKey: "sched:demo:hourly",
      ownerToken: "owner-a",
    });
    state.findRunOutcome.mockResolvedValue({ status: "success" });

    await cancelRunById(outerDb, "run-1", {
      actorLabel: "operator kate",
      runRegistry,
      settings: cancelSettings,
    });

    expect(state.stopSandboxes).not.toHaveBeenCalled();
    expect(runRegistry.release).not.toHaveBeenCalled();
  });

  // The compare-and-delete matched nothing because the claim had already gone.
  // The subject is free, so this is the same answer as finding it gone earlier,
  // not a conflict to retry.
  it("counts a refused release as done when the claim had already gone", async () => {
    workflowTerminal();
    const runRegistry = registry(scheduleClaim());
    vi.mocked(runRegistry.release).mockResolvedValue(false);
    vi.mocked(runRegistry.get)
      .mockResolvedValueOnce(scheduleClaim())
      .mockResolvedValue(null);
    state.findLiveClaim.mockResolvedValue({
      subjectKey: "sched:demo:hourly",
      ownerToken: "owner-a",
    });
    state.findRunOutcome.mockResolvedValue({ status: "success" });

    await expect(
      cancelRunById(outerDb, "run-1", {
        actorLabel: "MCP canary",
        runRegistry,
        settings: cancelSettings,
      }),
    ).resolves.toEqual({
      outcome: "already_terminal",
      subjectKey: "sched:demo:hourly",
      status: "success",
    });

    expect(runRegistry.beginCancellation).not.toHaveBeenCalled();
  });

  // The other half: the release was refused and the claim is still there, so
  // something else owns the outcome and the full cancel path answers.
  it("declines a refused release while the claim is still held", async () => {
    workflowTerminal();
    const runRegistry = registry(scheduleClaim());
    vi.mocked(runRegistry.release).mockResolvedValue(false);
    state.findLiveClaim.mockResolvedValue({
      subjectKey: "sched:demo:hourly",
      ownerToken: "owner-a",
    });
    state.findRunOutcome.mockResolvedValue({ status: "success" });

    await cancelRunById(outerDb, "run-1", {
      actorLabel: "operator kate",
      runRegistry,
      settings: cancelSettings,
    });

    expect(runRegistry.beginCancellation).toHaveBeenCalled();
  });

  // The withdrawal is a fence, not a courtesy: if the ticket cannot be proven out
  // of Ai the claim stays and the full cancel path answers instead.
  it("does not release a manual ticket claim when the withdrawal fails", async () => {
    workflowTerminal();
    state.moveTicket.mockRejectedValue(new Error("jira 503"));
    state.findLiveClaim.mockResolvedValue({
      subjectKey: "ticket:jira:PROJ-1",
      ticketKey: "PROJ-1",
      ownerToken: "owner-a",
      kind: "manual_ticket",
    });
    state.findRunOutcome.mockResolvedValue({ status: "success" });
    const runRegistry = registry(active({ kind: "manual_ticket" }));

    await cancelRunById(outerDb, "run-1", {
      actorLabel: "MCP canary",
      runRegistry,
      issueTracker: {} as IssueTrackerAdapter,
      settings: cancelSettings,
    });

    expect(runRegistry.release).not.toHaveBeenCalled();
  });

  // A claim already in "cancelling" belongs to a cancel that began and did not
  // finish. Converging it needs the clarification tombstone and the cancelling
  // fence the full path carries, so the shortcut declines it.
  it("leaves a cancelling claim to the full cancel path", async () => {
    workflowTerminal("cancelled");
    state.findLiveClaim.mockResolvedValue({
      subjectKey: "sched:demo:hourly",
      ownerToken: "owner-a",
    });
    state.findRunOutcome.mockResolvedValue({ status: "blocked" });
    const runRegistry = registry(scheduleClaim({ state: "cancelling" }));

    await expect(
      cancelRunById(outerDb, "run-1", {
        actorLabel: "MCP canary",
        runRegistry,
        settings: cancelSettings,
      }),
    ).resolves.toEqual({
      outcome: "already_terminal",
      subjectKey: "sched:demo:hourly",
      status: "blocked",
    });

    expect(runRegistry.release).not.toHaveBeenCalled();
    expect(runRegistry.beginCancellation).toHaveBeenCalled();
    expect(state.tombstone).toHaveBeenCalled();
    expect(runRegistry.releaseCancellation).toHaveBeenCalled();
  });

  // "awaiting" is a live park, not a terminal outcome: the run still owns its
  // subject and is waiting to be resumed, so cancelling one keeps today's teardown.
  it("keeps the full teardown for a run parked on a question", async () => {
    state.findLiveClaim.mockResolvedValue({
      subjectKey: "sched:demo:hourly",
      ownerToken: "owner-a",
    });
    state.findRunOutcome.mockResolvedValue({ status: "awaiting" });
    const runRegistry = registry(scheduleClaim({ state: "parked" }));

    await expect(
      cancelRunById(outerDb, "run-1", {
        actorLabel: "operator kate",
        runRegistry,
        settings: cancelSettings,
      }),
    ).resolves.toEqual({ outcome: "cancelled", subjectKey: "sched:demo:hourly" });

    expect(runRegistry.beginCancellation).toHaveBeenCalled();
    expect(state.markBlockedByOperator).toHaveBeenCalled();
    expect(runRegistry.release).not.toHaveBeenCalled();
  });

  // The claim went away between the reverse lookup and the release. The subject is
  // free, which is all the caller asked for, so this is not a retryable conflict.
  it("reports already_terminal when the lingering claim was released concurrently", async () => {
    workflowTerminal();
    state.findLiveClaim.mockResolvedValue({
      subjectKey: "sched:demo:hourly",
      ownerToken: "owner-a",
    });
    state.findRunOutcome.mockResolvedValue({ status: "success" });
    const runRegistry = registry(null);

    await expect(
      cancelRunById(outerDb, "run-1", {
        actorLabel: "MCP canary",
        runRegistry,
        settings: cancelSettings,
      }),
    ).resolves.toEqual({
      outcome: "already_terminal",
      subjectKey: "sched:demo:hourly",
      status: "success",
    });

    expect(runRegistry.release).not.toHaveBeenCalled();
    expect(runRegistry.beginCancellation).not.toHaveBeenCalled();
  });

  // A replacement run bound the same subject after the finished one left its claim
  // behind. Releasing that claim would free a subject a live run owns, so the
  // terminal shortcut declines it and the full path answers for the run asked for.
  it("does not release a claim that has moved to another owner", async () => {
    workflowTerminal();
    state.findLiveClaim.mockResolvedValue({
      subjectKey: "sched:demo:hourly",
      ownerToken: "owner-a",
    });
    state.findRunOutcome.mockResolvedValue({ status: "success" });
    const runRegistry = registry(scheduleClaim({ ownerToken: "owner-b", runId: "run-2" }));

    await expect(
      cancelRunById(outerDb, "run-1", {
        actorLabel: "MCP canary",
        runRegistry,
        settings: cancelSettings,
      }),
    ).resolves.toEqual({ outcome: "unconfirmed", subjectKey: "sched:demo:hourly" });

    expect(runRegistry.release).not.toHaveBeenCalled();
    expect(runRegistry.releaseCancellation).not.toHaveBeenCalled();
  });

  it("reports unconfirmed and keeps the claim when the live cancel cannot be confirmed", async () => {
    state.getRun.mockReturnValue({
      cancel: vi.fn().mockRejectedValue(new Error("unreachable")),
      status: Promise.resolve("running"),
    });
    state.findLiveClaim.mockResolvedValue({
      subjectKey: "sched:demo:hourly",
      ownerToken: "owner-a",
    });
    const runRegistry = registry(scheduleClaim());

    await expect(
      cancelRunById(outerDb, "run-1", {
        actorLabel: "operator",
        runRegistry,
        settings: cancelSettings,
      }),
    ).resolves.toEqual({ outcome: "unconfirmed", subjectKey: "sched:demo:hourly" });

    expect(state.markBlockedByOperator).not.toHaveBeenCalled();
    expect(runRegistry.releaseCancellation).not.toHaveBeenCalled();
  });

  // The other side of the discriminator: cancellation never began, so Workflow
  // was never touched and the claim is untouched. Retrying is the correct advice.
  it("reports unconfirmed and writes no status when the cancellation never began", async () => {
    state.findLiveClaim.mockResolvedValue({
      subjectKey: "sched:demo:hourly",
      ownerToken: "owner-a",
    });
    const runRegistry = registry(scheduleClaim());
    (runRegistry.beginCancellation as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    await expect(
      cancelRunById(outerDb, "run-1", {
        actorLabel: "operator kate",
        runRegistry,
        settings: cancelSettings,
      }),
    ).resolves.toEqual({ outcome: "unconfirmed", subjectKey: "sched:demo:hourly" });

    expect(state.markBlockedByOperator).not.toHaveBeenCalled();
    expect(runRegistry.releaseCancellation).not.toHaveBeenCalled();
  });

  it("reports already_terminal from workflow_runs for a run that already left the registry", async () => {
    state.findLiveClaim.mockResolvedValue(null);
    state.findRunOutcome.mockResolvedValue({ status: "success" });
    const runRegistry = registry(null);

    await expect(
      cancelRunById(outerDb, "run-done", {
        actorLabel: "operator",
        runRegistry,
        settings: cancelSettings,
      }),
    ).resolves.toEqual({ outcome: "already_terminal", status: "success" });

    // Not live: no cancellation is attempted.
    expect(runRegistry.beginCancellation).not.toHaveBeenCalled();
    expect(state.markBlockedByOperator).not.toHaveBeenCalled();
  });

  it("returns not_found when the run id is in neither table", async () => {
    state.findLiveClaim.mockResolvedValue(null);
    state.findRunOutcome.mockResolvedValue(null);
    const runRegistry = registry(null);

    await expect(
      cancelRunById(outerDb, "ghost", {
        actorLabel: "operator",
        runRegistry,
        settings: cancelSettings,
      }),
    ).resolves.toEqual({ outcome: "not_found" });

    expect(runRegistry.beginCancellation).not.toHaveBeenCalled();
  });
});

/**
 * The operator wrapper: cancelRunById plus the schedule-ledger settle that used to
 * live inline in the dashboard route. It is asserted here rather than there because
 * the settle is now shared by every operator-facing caller (the route and the MCP
 * runs.cancel tool), and the thing worth locking down is that no caller can lose it
 * and none can be broken by it.
 */
describe("cancelRunForOperator", () => {
  const operatorDb = { marker: "operator" } as unknown as Db;

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
    state.markBlockedByOperator.mockResolvedValue(undefined);
    state.findLiveClaim.mockResolvedValue(null);
    state.findRunOutcome.mockResolvedValue(null);
    state.settleOccurrence.mockResolvedValue(true);
  });

  /**
   * A live claim on the given subject, the shape cancelRunById resolves a run id to.
   * The run id has to match the claim's, or the core refuses the cancel as
   * unconfirmed and the settle under test never runs.
   */
  function live(runId: string, subjectKey: string, kind: ActiveRunEntry["kind"]) {
    state.findLiveClaim.mockResolvedValue({ subjectKey, ownerToken: "owner-a" });
    return registry(
      active({ subjectKey, ticketKey: null, kind, ownerToken: "owner-a", runId }),
    );
  }

  it("settles the schedule ledger for a cancelled schedule run", async () => {
    const runRegistry = live("run-1", "schedule:sch_1", "schedule");

    await expect(
      cancelRunForOperator(operatorDb, "run-1", {
        actorLabel: "operator kate",
        runRegistry,
        settings: cancelSettings,
      }),
    ).resolves.toEqual({
      outcome: "cancelled",
      subjectKey: "schedule:sch_1",
      scheduleOccurrenceSettled: true,
    });

    expect(state.settleOccurrence).toHaveBeenCalledWith("run-1");
    expect(state.warn).not.toHaveBeenCalled();
  });

  it("reports an unsettled occurrence and warns, without weakening the cancel", async () => {
    // The cancel landed in the bind-to-started window, so no started occurrence
    // carries this run id. The run is still gone, which is what the caller asked for.
    state.settleOccurrence.mockResolvedValue(false);
    const runRegistry = live("run-2", "schedule:sch_2", "schedule");

    await expect(
      cancelRunForOperator(operatorDb, "run-2", {
        actorLabel: "operator",
        runRegistry,
        settings: cancelSettings,
      }),
    ).resolves.toEqual({
      outcome: "cancelled",
      subjectKey: "schedule:sch_2",
      scheduleOccurrenceSettled: false,
    });

    expect(state.warn).toHaveBeenCalledWith(
      { runId: "run-2", subjectKey: "schedule:sch_2" },
      "schedule_run_cancel_occurrence_unsettled",
    );
  });

  it("swallows a throwing settle: the cancel already happened and cannot be undone", async () => {
    state.settleOccurrence.mockRejectedValue(new Error("ledger write failed"));
    const runRegistry = live("run-3", "schedule:sch_3", "schedule");

    await expect(
      cancelRunForOperator(operatorDb, "run-3", {
        actorLabel: "operator",
        runRegistry,
        settings: cancelSettings,
      }),
    ).resolves.toEqual({
      outcome: "cancelled",
      subjectKey: "schedule:sch_3",
      scheduleOccurrenceSettled: false,
    });

    expect(state.warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-3", error: "ledger write failed" }),
      "schedule_run_cancel_occurrence_unsettled",
    );
  });

  it("reports null instead of false for a run that has no occurrence to settle", async () => {
    // A webhook run owns no ledger row, so a settle that finds nothing is normal
    // there. Reporting it as null rather than false keeps "nothing to settle"
    // distinguishable from "should have settled and did not".
    state.settleOccurrence.mockResolvedValue(false);
    const runRegistry = live("run-4", "webhook:ep_1:delivery-9", "webhook_trigger");

    await expect(
      cancelRunForOperator(operatorDb, "run-4", {
        actorLabel: "operator",
        runRegistry,
        settings: cancelSettings,
      }),
    ).resolves.toEqual({
      outcome: "cancelled",
      subjectKey: "webhook:ep_1:delivery-9",
      scheduleOccurrenceSettled: null,
    });

    expect(state.warn).not.toHaveBeenCalled();
  });

  it("never touches the ledger when nothing was cancelled", async () => {
    state.findRunOutcome.mockResolvedValue({ status: "success" });
    const runRegistry = registry(null);

    await expect(
      cancelRunForOperator(operatorDb, "run-done", {
        actorLabel: "operator",
        runRegistry,
        settings: cancelSettings,
      }),
    ).resolves.toEqual({
      outcome: "already_terminal",
      status: "success",
      scheduleOccurrenceSettled: null,
    });

    // Settling an occurrence for a run that ended on its own would close a row the
    // run itself is responsible for closing.
    expect(state.settleOccurrence).not.toHaveBeenCalled();
  });
});
