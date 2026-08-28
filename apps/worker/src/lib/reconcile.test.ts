import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ActiveRunEntry,
  FailedTicketMeta,
  RunRegistryAdapter,
} from "../adapters/run-registry/types.js";
import {
  IssueTrackerNotFoundError,
  type IssueTrackerAdapter,
} from "../adapters/issue-tracker/types.js";
import type { Db } from "../db/client.js";

vi.mock("../../env.js", () => ({
  env: {
    JIRA_PROJECT_KEY: "PROJ",
    COLUMN_AI: "AI",
    COLUMN_AI_REVIEW: "Review",
    COLUMN_BACKLOG: "Backlog",
    JIRA_BACKLOG_TRANSITION_ID: undefined,
  },
}));

const mockGetRun = vi.fn();
const mockCancelRunDetailed = vi.fn();
const mockCancelSubjectRunDetailed = vi.fn();
const mockIsRunRecordedFailed = vi.fn();
const mockIsRunRecordedSucceeded = vi.fn();
const mockHasDurableRunPublication = vi.fn();
const mockDb = {} as Db;
const mockStopSandboxesByIds = vi.fn();
const mockListWorkflowSteps = vi.fn();
const mockReconcileStalledRun = vi.hoisted(() => vi.fn().mockResolvedValue(false));
const mockAssertActiveRunOwnerState = vi.hoisted(() => vi.fn());
vi.mock("workflow/api", () => ({ getRun: (...args: any[]) => mockGetRun(...args) }));
vi.mock("workflow/runtime", () => ({
  getWorld: () => ({
    steps: { list: (...args: any[]) => mockListWorkflowSteps(...args) },
  }),
}));
vi.mock("./cancel-run.js", () => ({
  cancelRunDetailed: (...args: any[]) => mockCancelRunDetailed(...args),
  cancelSubjectRunDetailed: (...args: any[]) => mockCancelSubjectRunDetailed(...args),
}));
vi.mock("../db/queries/runs-read.js", () => ({
  isRunRecordedFailed: (...args: any[]) => mockIsRunRecordedFailed(...args),
  isRunRecordedSucceeded: (...args: any[]) => mockIsRunRecordedSucceeded(...args),
  hasDurableRunPublication: (...args: any[]) => mockHasDurableRunPublication(...args),
}));
vi.mock("./run-start-lifecycle.js", () => ({
  reconcileStartupWatchdog: vi.fn().mockResolvedValue({
    selected: 0,
    cancelled: 0,
    retryable: 0,
  }),
}));
vi.mock("../sandbox/stop-ticket-sandboxes.js", () => ({
  stopSandboxesByIds: (...args: any[]) => mockStopSandboxesByIds(...args),
}));
vi.mock("./run-stall-watchdog.js", () => ({
  reconcileStalledRun: (...args: any[]) => mockReconcileStalledRun(...args),
}));
vi.mock("./active-run-owner.js", () => ({
  assertActiveRunOwnerState: (...args: any[]) => mockAssertActiveRunOwnerState(...args),
}));

function entry(overrides: Partial<ActiveRunEntry> = {}): ActiveRunEntry {
  return {
    subjectKey: "ticket:jira:PROJ-1",
    ticketKey: "PROJ-1",
    ownerToken: "owner-a",
    runId: "run-1",
    state: "bound",
    kind: "ticket",
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 60_000,
    ...overrides,
  };
}

function registry(
  entries: ActiveRunEntry[],
  failed: Array<{ ticketKey: string; meta: FailedTicketMeta }> = [],
): RunRegistryAdapter {
  return {
    reserve: vi.fn(),
    commitStartedRun: vi.fn(),
    markRunEntryStarted: vi.fn(),
    bindRun: vi.fn(),
    handoff: vi.fn(),
    get: vi.fn(async (subjectKey) => entries.find((row) => row.subjectKey === subjectKey) ?? null),
    beginParking: vi.fn().mockResolvedValue(true),
    finishParking: vi.fn().mockResolvedValue(true),
    beginCancellation: vi.fn().mockResolvedValue(true),
    releaseCancellation: vi.fn().mockResolvedValue(true),
    releaseReservation: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(true),
    listAll: vi.fn().mockResolvedValue(entries),
    registerSandbox: vi.fn(),
    listSandboxes: vi.fn().mockResolvedValue(["sbx-parent", "sbx-child"]),
    markFailed: vi.fn(),
    isTicketFailed: vi.fn(),
    listAllFailed: vi.fn().mockResolvedValue(failed),
    clearFailedMark: vi.fn(),
  };
}

function issueTracker(
  status = "AI",
  identifier = "PROJ-1",
  extra: {
    trackerStatusId?: string;
    reviewDestination?: { id: string; name: string } | null;
  } = {},
): IssueTrackerAdapter {
  return {
    fetchTicket: vi.fn().mockResolvedValue({
      id: "ticket-id",
      identifier,
      title: "Ticket",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      labels: [],
      trackerStatus: status,
      ...(extra.trackerStatusId ? { trackerStatusId: extra.trackerStatusId } : {}),
    }),
    moveTicket: vi.fn(),
    postComment: vi.fn(),
    searchTickets: vi.fn(),
    resolveMoveTargetStatus: vi
      .fn()
      .mockResolvedValue(extra.reviewDestination ?? null),
  };
}

describe("reconcileRuns owner-CAS recovery", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    (await import("./ai-review-destination.js")).resetAiReviewDestinationCache();
    mockStopSandboxesByIds.mockResolvedValue(2);
    mockIsRunRecordedFailed.mockResolvedValue(false);
    mockIsRunRecordedSucceeded.mockResolvedValue(false);
    mockHasDurableRunPublication.mockResolvedValue(false);
    mockListWorkflowSteps.mockResolvedValue({
      data: [],
      cursor: null,
      hasMore: false,
    });
    mockAssertActiveRunOwnerState.mockResolvedValue(undefined);
  });

  it("leaves a fresh unbound reservation for its candidate", async () => {
    const reserved = entry({ state: "reserved", runId: null, updatedAt: Date.now() });
    const runRegistry = registry([reserved]);
    const { reconcileRuns } = await import("./reconcile.js");

    expect(await reconcileRuns(new Set(["PROJ-1"]), runRegistry)).toEqual({
      cancelled: 0,
      cleaned: 0,
    });
    expect(runRegistry.releaseReservation).not.toHaveBeenCalled();
  });

  it("uses an adapter's atomic expiry decision instead of the process clock", async () => {
    const reserved = entry({ state: "reserved", runId: null, updatedAt: Date.now() });
    const runRegistry = registry([reserved]);
    runRegistry.releaseExpiredReservation = vi.fn().mockResolvedValue(true);
    const onReleased = vi.fn().mockResolvedValue(undefined);
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(new Set(["PROJ-1"]), runRegistry, undefined, undefined, onReleased),
    ).toEqual({ cancelled: 0, cleaned: 1 });
    expect(runRegistry.releaseExpiredReservation).toHaveBeenCalledWith(
      reserved.subjectKey,
      reserved.ownerToken,
    );
    expect(runRegistry.releaseReservation).not.toHaveBeenCalled();
    expect(mockStopSandboxesByIds).not.toHaveBeenCalled();
    expect(onReleased).toHaveBeenCalledWith(reserved.subjectKey);
  });

  it("releases a stale reservation, stops all exact sandboxes, and drains once", async () => {
    const reserved = entry({
      state: "reserved",
      runId: null,
      updatedAt: Date.now() - 10 * 60_000,
    });
    const runRegistry = registry([reserved]);
    const onReleased = vi.fn().mockResolvedValue(undefined);
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(new Set(["PROJ-1"]), runRegistry, undefined, undefined, onReleased),
    ).toEqual({ cancelled: 0, cleaned: 1 });
    expect(mockStopSandboxesByIds).toHaveBeenCalledWith(["sbx-parent", "sbx-child"]);
    expect(runRegistry.releaseReservation).toHaveBeenCalledWith(
      reserved.subjectKey,
      reserved.ownerToken,
    );
    expect(onReleased).toHaveBeenCalledWith(reserved.subjectKey);
  });

  it("does not drain when stale-reservation CAS loses to another terminal path", async () => {
    const reserved = entry({
      state: "reserved",
      runId: null,
      updatedAt: Date.now() - 10 * 60_000,
    });
    const runRegistry = registry([reserved]);
    vi.mocked(runRegistry.releaseReservation).mockResolvedValue(false);
    const onReleased = vi.fn();
    const { reconcileRuns } = await import("./reconcile.js");

    await reconcileRuns(new Set(["PROJ-1"]), runRegistry, undefined, undefined, onReleased);

    expect(onReleased).not.toHaveBeenCalled();
  });

  it("owner-releases a terminal synthetic PR run and drains its pending event", async () => {
    const bound = entry({
      subjectKey: "pr:github:acme/app#7",
      ticketKey: null,
      kind: "pr_trigger",
    });
    const runRegistry = registry([bound]);
    mockGetRun.mockReturnValue({ status: Promise.resolve("completed") });
    const onReleased = vi.fn();
    const { reconcileRuns } = await import("./reconcile.js");

    expect(await reconcileRuns(new Set(), runRegistry, undefined, undefined, onReleased)).toEqual({
      cancelled: 0,
      cleaned: 1,
    });
    expect(runRegistry.release).toHaveBeenCalledWith(
      bound.subjectKey,
      bound.ownerToken,
      bound.runId,
    );
    expect(mockStopSandboxesByIds).toHaveBeenCalledWith(["sbx-parent", "sbx-child"]);
    expect(onReleased).toHaveBeenCalledWith(bound.subjectKey);
  });

  it("retains an externally cancelled owner until its Workflow steps drain", async () => {
    const bound = entry({
      subjectKey: "pr:github:acme/app#draining",
      ticketKey: null,
      kind: "pr_trigger",
    });
    const runRegistry = registry([bound]);
    const onReleased = vi.fn();
    mockGetRun.mockReturnValue({ status: Promise.resolve("cancelled") });
    mockListWorkflowSteps
      .mockResolvedValueOnce({
        data: [{ status: "running" }],
        cursor: null,
        hasMore: false,
      })
      .mockResolvedValueOnce({
        data: [{ status: "completed" }],
        cursor: null,
        hasMore: false,
      });
    const { reconcileRuns } = await import("./reconcile.js");

    await expect(
      reconcileRuns(new Set(), runRegistry, undefined, undefined, onReleased),
    ).resolves.toEqual({ cancelled: 0, cleaned: 0 });
    expect(runRegistry.release).not.toHaveBeenCalled();
    expect(mockStopSandboxesByIds).not.toHaveBeenCalled();

    await expect(
      reconcileRuns(new Set(), runRegistry, undefined, undefined, onReleased),
    ).resolves.toEqual({ cancelled: 0, cleaned: 1 });
    expect(runRegistry.release).toHaveBeenCalledOnce();
    expect(onReleased).toHaveBeenCalledWith(bound.subjectKey);
  });

  it("never drains after a terminal owner loses compare-and-delete", async () => {
    const bound = entry({ kind: "pr_trigger" });
    const runRegistry = registry([bound]);
    vi.mocked(runRegistry.release).mockResolvedValue(false);
    mockGetRun.mockReturnValue({ status: Promise.resolve("completed") });
    const onReleased = vi.fn();
    const { reconcileRuns } = await import("./reconcile.js");

    await reconcileRuns(new Set(), runRegistry, undefined, undefined, onReleased);

    expect(onReleased).not.toHaveBeenCalled();
  });

  it("retains a terminal owner when owned sandbox cleanup is unconfirmed", async () => {
    const bound = entry({ kind: "pr_trigger" });
    const runRegistry = registry([bound]);
    mockGetRun.mockReturnValue({ status: Promise.resolve("completed") });
    mockStopSandboxesByIds.mockRejectedValue(new Error("sandbox API unavailable"));
    const onReleased = vi.fn();
    const { reconcileRuns } = await import("./reconcile.js");

    expect(await reconcileRuns(new Set(), runRegistry, undefined, undefined, onReleased)).toEqual({
      cancelled: 0,
      cleaned: 0,
    });
    expect(runRegistry.release).not.toHaveBeenCalled();
    expect(onReleased).not.toHaveBeenCalled();
  });

  it("keeps a bound run when Jira confirms it is still in the AI column", async () => {
    const bound = entry();
    const runRegistry = registry([bound]);
    const tracker = issueTracker();
    const { reconcileRuns } = await import("./reconcile.js");

    expect(await reconcileRuns(new Set(), runRegistry, tracker)).toEqual({
      cancelled: 0,
      cleaned: 0,
    });
    expect(mockCancelRunDetailed).not.toHaveBeenCalled();
  });

  it("evicts a ticket to Backlog instead of silently releasing the claim once a stuck run goes terminal", async () => {
    // Reproduces AIW-289: a `terminate` node (e.g. an injection screen's block
    // path) can end a run as "done"/"skipped" without ever moving the ticket
    // out of AI. Simply releasing the claim here would leave the ticket
    // sitting in AI with nobody bound to it, so the very next poll's JQL
    // discovery re-dispatches a second run on the same ticket. Exactly one run
    // per ticket depends on this branch evicting it instead.
    const bound = entry();
    const runRegistry = registry([bound]);
    const tracker = issueTracker("AI");
    mockGetRun.mockReturnValue({ status: Promise.resolve("completed") });
    mockCancelRunDetailed.mockResolvedValue({
      cancelled: true,
      released: true,
      alreadyTerminal: true,
    });
    const onReleased = vi.fn();
    const onTicketCancelled = vi.fn();
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(
        new Set(["PROJ-1"]),
        runRegistry,
        tracker,
        onTicketCancelled,
        onReleased,
      ),
    ).toEqual({ cancelled: 0, cleaned: 1 });
    expect(mockCancelRunDetailed).toHaveBeenCalledWith(
      "PROJ-1",
      "run-1",
      runRegistry,
      tracker,
      "Backlog",
      onReleased,
      expect.stringContaining("moved this ticket to Backlog"),
    );
    // Genuinely a "done"/success outcome for the injection-block scenario, so
    // it must not be reported to operators as a cancellation.
    expect(onTicketCancelled).not.toHaveBeenCalled();
  });

  it.each(["Review", "Done"])(
    "releases a terminal manual ticket without overwriting live Jira %s from a stale AI snapshot",
    async (liveStatus) => {
      const manual = entry({ kind: "manual_ticket" });
      const runRegistry = registry([manual]);
      const tracker = issueTracker(liveStatus);
      mockGetRun.mockReturnValue({ status: Promise.resolve("completed") });
      const onReleased = vi.fn();
      const { reconcileRuns } = await import("./reconcile.js");

      await expect(
        reconcileRuns(
          new Set(["PROJ-1"]),
          runRegistry,
          tracker,
          undefined,
          onReleased,
          undefined,
          mockDb,
        ),
      ).resolves.toEqual({ cancelled: 0, cleaned: 1 });
      expect(mockCancelRunDetailed).not.toHaveBeenCalled();
      expect(tracker.fetchTicket).toHaveBeenCalledOnce();
      expect(tracker.moveTicket).not.toHaveBeenCalled();
      expect(mockAssertActiveRunOwnerState).toHaveBeenCalledWith(
        mockDb,
        manual,
        "bound",
      );
      expect(runRegistry.release).toHaveBeenCalledWith(
        manual.subjectKey,
        manual.ownerToken,
        manual.runId,
      );
      expect(onReleased).toHaveBeenCalledWith(manual.subjectKey);
    },
  );

  it("evicts a terminal manual ticket when the capped AI snapshot omits it but Jira still reports AI", async () => {
    const manual = entry({ kind: "manual_ticket" });
    const runRegistry = registry([manual]);
    const tracker = issueTracker("AI");
    mockGetRun.mockReturnValue({ status: Promise.resolve("completed") });
    const onReleased = vi.fn();
    const { reconcileRuns } = await import("./reconcile.js");

    await expect(
      reconcileRuns(
        new Set(),
        runRegistry,
        tracker,
        undefined,
        onReleased,
        undefined,
        mockDb,
      ),
    ).resolves.toEqual({ cancelled: 0, cleaned: 1 });
    expect(mockAssertActiveRunOwnerState).toHaveBeenCalledWith(
      mockDb,
      manual,
      "bound",
    );
    expect(tracker.moveTicket).toHaveBeenCalledTimes(1);
    expect(tracker.moveTicket).toHaveBeenCalledWith("PROJ-1", "Backlog");
    expect(runRegistry.release).toHaveBeenCalledTimes(1);
    expect(runRegistry.release).toHaveBeenCalledWith(
      manual.subjectKey,
      manual.ownerToken,
      manual.runId,
    );
    expect(onReleased).toHaveBeenCalledTimes(1);
    expect(onReleased).toHaveBeenCalledWith(manual.subjectKey);
  });

  it("retains a manual claim omitted from the snapshot when Jira's live read is uncertain", async () => {
    const manual = entry({ kind: "manual_ticket" });
    const runRegistry = registry([manual]);
    const tracker = issueTracker();
    vi.mocked(tracker.fetchTicket).mockRejectedValue(new Error("Jira unavailable"));
    const { reconcileRuns } = await import("./reconcile.js");

    await expect(
      reconcileRuns(new Set(), runRegistry, tracker, undefined, undefined, undefined, mockDb),
    ).resolves.toEqual({ cancelled: 0, cleaned: 0 });
    expect(tracker.moveTicket).not.toHaveBeenCalled();
    expect(runRegistry.release).not.toHaveBeenCalled();
  });

  it("retains a manual claim when stale-snapshot withdrawal cannot be confirmed", async () => {
    const manual = entry({ kind: "manual_ticket" });
    const runRegistry = registry([manual]);
    const tracker = issueTracker("AI");
    const moveError = new Error("response lost");
    vi.mocked(tracker.fetchTicket)
      .mockResolvedValueOnce({ trackerStatus: "AI" } as never)
      .mockResolvedValueOnce({ trackerStatus: "AI" } as never);
    vi.mocked(tracker.moveTicket).mockRejectedValue(moveError);
    mockGetRun.mockReturnValue({ status: Promise.resolve("completed") });
    const { reconcileRuns } = await import("./reconcile.js");

    await expect(
      reconcileRuns(
        new Set(["PROJ-1"]),
        runRegistry,
        tracker,
        undefined,
        undefined,
        undefined,
        mockDb,
      ),
    ).resolves.toEqual({ cancelled: 0, cleaned: 0 });
    expect(tracker.moveTicket).toHaveBeenCalledWith("PROJ-1", "Backlog");
    expect(tracker.fetchTicket).toHaveBeenCalledTimes(2);
    expect(runRegistry.release).not.toHaveBeenCalled();
  });

  it("does not evict a ticket-triggered run that is still executing", async () => {
    const bound = entry();
    const runRegistry = registry([bound]);
    const tracker = issueTracker("AI");
    mockGetRun.mockReturnValue({ status: Promise.resolve("running") });
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(new Set(["PROJ-1"]), runRegistry, tracker),
    ).toEqual({ cancelled: 0, cleaned: 0 });
    expect(mockCancelRunDetailed).not.toHaveBeenCalled();
    expect(runRegistry.release).not.toHaveBeenCalled();
  });

  it("retains a stuck ticket's claim when the eviction cannot be confirmed", async () => {
    const bound = entry();
    const runRegistry = registry([bound]);
    const tracker = issueTracker("AI");
    mockGetRun.mockReturnValue({ status: Promise.resolve("completed") });
    mockCancelRunDetailed.mockResolvedValue({ cancelled: false, released: false });
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(new Set(["PROJ-1"]), runRegistry, tracker),
    ).toEqual({ cancelled: 0, cleaned: 0 });
  });

  it("lets a pending clarification win over an older answered round", async () => {
    const parked = entry();
    const runRegistry = registry([parked]);
    mockGetRun.mockReturnValue({ status: Promise.resolve("completed") });
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(
        new Set(),
        runRegistry,
        issueTracker("Done"),
        undefined,
        undefined,
        new Set([parked.subjectKey]),
        undefined,
        new Set([parked.subjectKey]),
      ),
    ).toEqual({ cancelled: 0, cleaned: 0 });
    expect(mockGetRun).not.toHaveBeenCalled();
    expect(mockCancelRunDetailed).not.toHaveBeenCalled();
    expect(runRegistry.release).not.toHaveBeenCalled();
    expect(mockReconcileStalledRun).not.toHaveBeenCalled();
  });

  it("runs the stall watchdog before terminal cleanup for a bound answered clarification", async () => {
    const answered = entry();
    const runRegistry = registry([answered]);
    const onReleased = vi.fn();
    mockReconcileStalledRun.mockResolvedValueOnce(true);
    const { reconcileRuns } = await import("./reconcile.js");

    await expect(
      reconcileRuns(
        new Set(),
        runRegistry,
        issueTracker("Review"),
        undefined,
        onReleased,
        new Set(),
        mockDb,
        new Set([answered.subjectKey]),
      ),
    ).resolves.toEqual({ cancelled: 1, cleaned: 0 });
    expect(mockReconcileStalledRun).toHaveBeenCalledWith(
      expect.objectContaining({ entry: answered, db: mockDb }),
    );
    expect(runRegistry.release).not.toHaveBeenCalled();
  });

  it("terminal-cleans an answered same-run clarification instead of retaining it forever", async () => {
    const answered = entry();
    const runRegistry = registry([answered]);
    const tracker = issueTracker("Done");
    const db = { db: true } as never;
    const onReleased = vi.fn();
    mockGetRun.mockReturnValue({ status: Promise.resolve("completed") });
    const { reconcileRuns } = await import("./reconcile.js");

    await expect(
      reconcileRuns(
        new Set(),
        runRegistry,
        tracker,
        undefined,
        onReleased,
        new Set(),
        db,
        new Set([answered.subjectKey]),
      ),
    ).resolves.toEqual({ cancelled: 0, cleaned: 1 });
    expect(mockCancelRunDetailed).not.toHaveBeenCalled();
    expect(runRegistry.release).toHaveBeenCalledWith(
      answered.subjectKey,
      answered.ownerToken,
      answered.runId,
    );
    expect(onReleased).toHaveBeenCalledWith(answered.subjectKey);
  });

  it("keeps a running answered clarification without orphan-cancelling it outside AI", async () => {
    const answered = entry();
    const runRegistry = registry([answered]);
    const tracker = issueTracker("Done");
    mockGetRun.mockReturnValue({ status: Promise.resolve("running") });
    const { reconcileRuns } = await import("./reconcile.js");

    await expect(
      reconcileRuns(
        new Set(),
        runRegistry,
        tracker,
        undefined,
        undefined,
        new Set(),
        undefined,
        new Set([answered.subjectKey]),
      ),
    ).resolves.toEqual({ cancelled: 0, cleaned: 0 });
    expect(mockCancelRunDetailed).not.toHaveBeenCalled();
    expect(runRegistry.release).not.toHaveBeenCalled();
  });

  it("keeps a terminal answered clarification until its Workflow steps drain", async () => {
    const answered = entry();
    const runRegistry = registry([answered]);
    mockGetRun.mockReturnValue({ status: Promise.resolve("completed") });
    mockListWorkflowSteps.mockResolvedValue({
      data: [{ status: "running" }],
      cursor: null,
      hasMore: false,
    });
    const { reconcileRuns } = await import("./reconcile.js");

    await expect(
      reconcileRuns(
        new Set(),
        runRegistry,
        issueTracker("Done"),
        undefined,
        undefined,
        new Set(),
        undefined,
        new Set([answered.subjectKey]),
      ),
    ).resolves.toEqual({ cancelled: 0, cleaned: 0 });
    expect(mockCancelRunDetailed).not.toHaveBeenCalled();
    expect(runRegistry.release).not.toHaveBeenCalled();
  });

  it("releases an approval-parked owner quietly instead of cancelling it as an orphan", async () => {
    // send_plan_approval ends its run with the ticket parked outside AI, so the
    // bound claim is terminal bookkeeping. Cancelling it retires the pending
    // approval (no decision, no successor) and strands the ticket; the poll
    // routes these subjects to terminal cleanup, which frees the claim the
    // approval dispatch needs without touching the approval row.
    const parked = entry();
    const runRegistry = registry([parked]);
    const onReleased = vi.fn();
    mockGetRun.mockReturnValue({ status: Promise.resolve("completed") });
    const { reconcileRuns } = await import("./reconcile.js");

    await expect(
      reconcileRuns(
        new Set(),
        runRegistry,
        issueTracker("Backlog"),
        undefined,
        onReleased,
        new Set(),
        undefined,
        new Set([parked.subjectKey]),
      ),
    ).resolves.toEqual({ cancelled: 0, cleaned: 1 });
    expect(mockCancelRunDetailed).not.toHaveBeenCalled();
    expect(runRegistry.release).toHaveBeenCalledWith(
      parked.subjectKey,
      parked.ownerToken,
      parked.runId,
    );
    expect(onReleased).toHaveBeenCalledWith(parked.subjectKey);
  });

  it("runs the cancellation cascade on the same owner when it is not reported as approval-parked", async () => {
    // Negative companion: without the terminal-channel classification the exact
    // same entry takes the orphan path, and that cascade is what superseded the
    // pending approvals in production.
    const parked = entry();
    const runRegistry = registry([parked]);
    mockGetRun.mockReturnValue({ status: Promise.resolve("completed") });
    mockCancelRunDetailed.mockResolvedValue({
      cancelled: true,
      released: true,
      alreadyTerminal: true,
    });
    const { reconcileRuns } = await import("./reconcile.js");

    await expect(
      reconcileRuns(
        new Set(),
        runRegistry,
        issueTracker("Backlog"),
        undefined,
        undefined,
        new Set(),
        undefined,
        new Set(),
      ),
    ).resolves.toEqual({ cancelled: 1, cleaned: 0 });
    expect(mockCancelRunDetailed).toHaveBeenCalledWith(
      "PROJ-1",
      "run-1",
      runRegistry,
      expect.anything(),
      undefined,
      undefined,
      "Orphaned run cancelled by reconciler: ticket no longer in the AI column",
    );
    expect(runRegistry.release).not.toHaveBeenCalled();
  });

  it("recovers an interrupted parking drain before protecting the clarification", async () => {
    const parking = entry({ state: "parking" });
    const runRegistry = registry([parking]);
    vi.mocked(runRegistry.finishParking!).mockImplementation(async () => {
      parking.state = "parked";
      return true;
    });
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(
        new Set(),
        runRegistry,
        issueTracker("Done"),
        undefined,
        undefined,
        new Set([parking.subjectKey]),
      ),
    ).toEqual({ cancelled: 0, cleaned: 0 });
    expect(runRegistry.beginParking).toHaveBeenCalledWith(
      parking.subjectKey,
      parking.ownerToken,
      parking.runId,
    );
    expect(mockStopSandboxesByIds).toHaveBeenCalledWith(["sbx-parent", "sbx-child"]);
    expect(runRegistry.finishParking).toHaveBeenCalledWith(
      parking.subjectKey,
      parking.ownerToken,
      parking.runId,
    );
    expect(mockCancelRunDetailed).not.toHaveBeenCalled();
  });

  it("does not strand an expired parked clarification owner outside generic cleanup", async () => {
    const parked = entry({ state: "parked" });
    const runRegistry = registry([parked]);
    const tracker = issueTracker("Done");
    mockCancelRunDetailed.mockResolvedValue({ cancelled: true, released: true });
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(new Set(), runRegistry, tracker),
    ).toEqual({ cancelled: 1, cleaned: 0 });
    expect(mockCancelRunDetailed).toHaveBeenCalledWith(
      "PROJ-1",
      "run-1",
      runRegistry,
      tracker,
      undefined,
      undefined,
      "Orphaned run cancelled by reconciler: ticket no longer in the AI column",
    );
  });

  it("warns when a closing claim fails to converge again instead of staying silent", async () => {
    const closing = entry({ state: "cancelling" });
    const runRegistry = registry([closing]);
    const tracker = issueTracker("AI");
    mockCancelRunDetailed.mockResolvedValue({ cancelled: false, released: false, tornDown: true });
    const { logger } = await import("./logger.js");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(new Set(["PROJ-1"]), runRegistry, tracker),
    ).toEqual({ cancelled: 0, cleaned: 0 });
    expect(warn).toHaveBeenCalledWith(
      { subjectKey: closing.subjectKey, ticketKey: "PROJ-1", runId: "run-1", tornDown: true },
      "reconcile_cancelling_claim_unconverged",
    );
    warn.mockRestore();
  });

  it("settles a bound run the stall watchdog reports dead before any column logic runs", async () => {
    const bound = entry({ state: "bound" });
    const runRegistry = registry([bound]);
    const tracker = issueTracker("AI");
    const onReleased = vi.fn();
    mockReconcileStalledRun.mockResolvedValueOnce(true);
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(
        new Set(["PROJ-1"]),
        runRegistry,
        tracker,
        undefined,
        onReleased,
        undefined,
        mockDb,
      ),
    ).toEqual({ cancelled: 1, cleaned: 0 });
    expect(mockReconcileStalledRun).toHaveBeenCalledWith({
      entry: bound,
      runRegistry,
      db: mockDb,
      issueTracker: tracker,
      moveTarget: "Backlog",
      onSubjectReleased: onReleased,
    });
    expect(mockGetRun).not.toHaveBeenCalled();
    expect(mockCancelRunDetailed).not.toHaveBeenCalled();
  });

  it("offers Backlog to the watchdog even when the snapshot says the ticket left AI", async () => {
    const bound = entry({ state: "bound" });
    const runRegistry = registry([bound]);
    mockReconcileStalledRun.mockResolvedValueOnce(true);
    const { reconcileRuns } = await import("./reconcile.js");

    await reconcileRuns(new Set(), runRegistry, issueTracker("Done"), undefined, undefined, undefined, mockDb);

    expect(mockReconcileStalledRun).toHaveBeenCalledWith(
      expect.objectContaining({ moveTarget: "Backlog" }),
    );
  });

  it("runs the stall watchdog only with a database to settle the run in", async () => {
    const bound = entry({ state: "bound" });
    const runRegistry = registry([bound]);
    mockGetRun.mockReturnValue({ status: Promise.resolve("running") });
    const { reconcileRuns } = await import("./reconcile.js");

    await reconcileRuns(new Set(["PROJ-1"]), runRegistry, issueTracker("AI"));

    expect(mockReconcileStalledRun).not.toHaveBeenCalled();
  });

  it("retries a closing ticket claim and confirms Backlog before it can be released", async () => {
    const closing = entry({ state: "cancelling" });
    const runRegistry = registry([closing]);
    const tracker = issueTracker("AI");
    mockCancelRunDetailed.mockResolvedValue({ cancelled: true, released: true });
    const onReleased = vi.fn();
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(
        new Set(["PROJ-1"]),
        runRegistry,
        tracker,
        undefined,
        onReleased,
        new Set([closing.subjectKey]),
      ),
    ).toEqual({ cancelled: 1, cleaned: 0 });
    expect(mockCancelRunDetailed).toHaveBeenCalledWith(
      "PROJ-1",
      { ownerToken: "owner-a", runId: "run-1" },
      runRegistry,
      tracker,
      "Backlog",
      onReleased,
      "Orphaned run cancelled by reconciler: ticket no longer in the AI column",
      expect.any(Function),
    );
  });

  it("passes Jira to a closing ticket retry outside AI so durable post-drain cleanup can finish", async () => {
    const closing = entry({ state: "cancelling" });
    const runRegistry = registry([closing]);
    const tracker = issueTracker("Done");
    mockCancelRunDetailed.mockResolvedValue({ cancelled: true, released: true });
    const onReleased = vi.fn();
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(new Set(), runRegistry, tracker, undefined, onReleased),
    ).toEqual({ cancelled: 1, cleaned: 0 });
    expect(mockCancelRunDetailed).toHaveBeenCalledWith(
      "PROJ-1",
      { ownerToken: "owner-a", runId: "run-1" },
      runRegistry,
      tracker,
      undefined,
      onReleased,
      "Orphaned run cancelled by reconciler: ticket no longer in the AI column",
      expect.any(Function),
    );
  });

  it("rechecks a closing ticket before release when AI moved to Review", async () => {
    const closing = entry({ state: "cancelling" });
    const runRegistry = registry([closing]);
    const tracker = issueTracker("AI");
    const fetchTicket = vi.mocked(tracker.fetchTicket);
    const ticket = {
      id: "ticket-id",
      identifier: "PROJ-1",
      title: "Ticket",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      labels: [],
      trackerStatus: "AI",
      attachments: [],
    };
    fetchTicket
      .mockReset()
      .mockResolvedValueOnce(ticket)
      .mockResolvedValueOnce({ ...ticket, trackerStatus: "Review" });
    mockCancelRunDetailed
      .mockReset()
      .mockImplementationOnce(async (...args: any[]) => {
        const fence = args[7] as (owner: {
          subjectKey: string;
          ownerToken: string;
          runId: string | null;
        }) => Promise<void>;
        await fence({
          subjectKey: closing.subjectKey,
          ownerToken: closing.ownerToken,
          runId: closing.runId,
        });
        return { cancelled: true, released: true };
      });
    const { reconcileRuns } = await import("./reconcile.js");

    await expect(
      reconcileRuns(
        new Set(["PROJ-1"]),
        runRegistry,
        tracker,
        undefined,
        undefined,
        undefined,
        mockDb,
      ),
    ).resolves.toEqual({ cancelled: 1, cleaned: 0 });

    expect(fetchTicket).toHaveBeenCalledTimes(2);
    expect(tracker.moveTicket).not.toHaveBeenCalled();
    expect(mockAssertActiveRunOwnerState).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        subjectKey: closing.subjectKey,
        ownerToken: closing.ownerToken,
        runId: closing.runId,
      }),
      "cancelling",
    );
  });

  it("withdraws a closing ticket that moved from Review back to AI before release", async () => {
    const closing = entry({ state: "cancelling" });
    const runRegistry = registry([closing]);
    const tracker = issueTracker("Review");
    const fetchTicket = vi.mocked(tracker.fetchTicket);
    const ticket = {
      id: "ticket-id",
      identifier: "PROJ-1",
      title: "Ticket",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      labels: [],
      trackerStatus: "Review",
      attachments: [],
    };
    fetchTicket
      .mockReset()
      .mockResolvedValueOnce(ticket)
      .mockResolvedValueOnce({ ...ticket, trackerStatus: "AI" });
    mockCancelRunDetailed
      .mockReset()
      .mockImplementationOnce(async (...args: any[]) => {
        const fence = args[7] as (owner: {
          subjectKey: string;
          ownerToken: string;
          runId: string | null;
        }) => Promise<void>;
        await fence({
          subjectKey: closing.subjectKey,
          ownerToken: closing.ownerToken,
          runId: closing.runId,
        });
        return { cancelled: true, released: true };
      });
    const { reconcileRuns } = await import("./reconcile.js");

    await expect(
      reconcileRuns(
        new Set(),
        runRegistry,
        tracker,
        undefined,
        undefined,
        undefined,
        mockDb,
      ),
    ).resolves.toEqual({ cancelled: 1, cleaned: 0 });

    expect(fetchTicket).toHaveBeenCalledTimes(2);
    expect(tracker.moveTicket).toHaveBeenCalledWith("PROJ-1", "Backlog");
    expect(mockAssertActiveRunOwnerState).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        subjectKey: closing.subjectKey,
        ownerToken: closing.ownerToken,
        runId: closing.runId,
      }),
      "cancelling",
    );
  });

  it("releases a closing claim after the ticket is confirmed deleted", async () => {
    const closing = entry({ state: "cancelling" });
    const runRegistry = registry([closing]);
    const tracker = issueTracker("AI");
    vi.mocked(tracker.fetchTicket)
      .mockReset()
      .mockRejectedValue(new IssueTrackerNotFoundError("Jira issue", "PROJ-1"));
    mockCancelRunDetailed
      .mockReset()
      .mockImplementationOnce(async (...args: any[]) => {
        const fence = args[7] as (owner: {
          subjectKey: string;
          ownerToken: string;
          runId: string | null;
        }) => Promise<void>;
        await fence({
          subjectKey: closing.subjectKey,
          ownerToken: closing.ownerToken,
          runId: closing.runId,
        });
        return { cancelled: true, released: true };
      });
    const { reconcileRuns } = await import("./reconcile.js");

    await expect(
      reconcileRuns(
        new Set(),
        runRegistry,
        tracker,
        undefined,
        undefined,
        undefined,
        mockDb,
      ),
    ).resolves.toEqual({ cancelled: 1, cleaned: 0 });

    expect(vi.mocked(tracker.fetchTicket)).toHaveBeenCalledTimes(2);
    expect(tracker.moveTicket).not.toHaveBeenCalled();
    expect(mockAssertActiveRunOwnerState).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        subjectKey: closing.subjectKey,
        ownerToken: closing.ownerToken,
        runId: closing.runId,
      }),
      "cancelling",
    );
    await expect(mockCancelRunDetailed.mock.results[0]?.value).resolves.toEqual({
      cancelled: true,
      released: true,
    });
  });

  it("retries a closing ticketless claim without Jira mutation", async () => {
    const closing = entry({
      subjectKey: "pr:github:acme/app#9",
      ticketKey: null,
      kind: "pr_trigger",
      state: "cancelling",
    });
    const runRegistry = registry([closing]);
    mockCancelSubjectRunDetailed.mockResolvedValue({ cancelled: true, released: true });
    const onReleased = vi.fn();
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(
        new Set(),
        runRegistry,
        undefined,
        undefined,
        onReleased,
      ),
    ).toEqual({ cancelled: 1, cleaned: 0 });
    expect(mockCancelSubjectRunDetailed).toHaveBeenCalledWith(
      closing.subjectKey,
      { ownerToken: "owner-a", runId: "run-1" },
      runRegistry,
      onReleased,
      "Orphaned run cancelled by reconciler: ticket no longer in the AI column",
    );
  });

  it("retries a closing pull request claim on its own subject, not its ticket", async () => {
    const closing = entry({
      subjectKey: "pr:github:acme/app#9",
      ticketKey: "PROJ-1",
      kind: "pr_trigger",
      state: "cancelling",
    });
    const runRegistry = registry([closing]);
    const tracker = issueTracker("AI");
    mockCancelSubjectRunDetailed.mockResolvedValue({ cancelled: true, released: true });
    const onReleased = vi.fn();
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(
        new Set(["PROJ-1"]),
        runRegistry,
        tracker,
        undefined,
        onReleased,
      ),
    ).toEqual({ cancelled: 1, cleaned: 0 });
    expect(mockCancelSubjectRunDetailed).toHaveBeenCalledWith(
      "pr:github:acme/app#9",
      { ownerToken: "owner-a", runId: "run-1" },
      runRegistry,
      onReleased,
      "Orphaned run cancelled by reconciler: ticket no longer in the AI column",
    );
    expect(mockCancelRunDetailed).not.toHaveBeenCalled();
  });

  it("passes owner-gated drain through cancellation for a ticket that left AI", async () => {
    const bound = entry();
    const runRegistry = registry([bound]);
    const tracker = issueTracker("Done");
    const onReleased = vi.fn();
    mockCancelRunDetailed.mockImplementation(async (...args: unknown[]) => {
      const releaseCallback = args[5] as (subjectKey: string) => Promise<void>;
      await releaseCallback(bound.subjectKey);
      return { cancelled: true, released: true };
    });
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(new Set(), runRegistry, tracker, undefined, onReleased),
    ).toEqual({ cancelled: 1, cleaned: 0 });
    expect(mockCancelRunDetailed).toHaveBeenCalledWith(
      "PROJ-1",
      "run-1",
      runRegistry,
      tracker,
      undefined,
      onReleased,
      "Orphaned run cancelled by reconciler: ticket no longer in the AI column",
    );
    expect(onReleased).toHaveBeenCalledWith(bound.subjectKey);
  });

  it("applies normal AI-column cancellation semantics to manual ticket runs", async () => {
    const bound = entry({ kind: "manual_ticket" });
    const runRegistry = registry([bound]);
    mockCancelRunDetailed.mockResolvedValue({ cancelled: true, released: true });
    const { reconcileRuns } = await import("./reconcile.js");

    await expect(
      reconcileRuns(new Set(), runRegistry, issueTracker("Done")),
    ).resolves.toEqual({ cancelled: 1, cleaned: 0 });
    expect(mockCancelRunDetailed).toHaveBeenCalledWith(
      "PROJ-1",
      "run-1",
      runRegistry,
      expect.anything(),
      undefined,
      undefined,
      "Orphaned run cancelled by reconciler: ticket no longer in the AI column",
    );
  });

  it("retains a bound run whose ticket sits in the AI Review column while it still executes", async () => {
    // A Jira automation rule raced the run's own success move: the ticket
    // reached AI Review while the run is still finalizing (world status
    // "running"). Cancelling now would record a genuine success as blocked.
    const bound = entry();
    const runRegistry = registry([bound]);
    mockGetRun.mockReturnValue({ status: Promise.resolve("running") });
    mockHasDurableRunPublication.mockResolvedValue(true);
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(
        new Set(),
        runRegistry,
        issueTracker("Review"),
        undefined,
        undefined,
        undefined,
        mockDb,
      ),
    ).toEqual({ cancelled: 0, cleaned: 0 });
    expect(mockCancelRunDetailed).not.toHaveBeenCalled();
    expect(runRegistry.release).not.toHaveBeenCalled();
  });

  it("retains a still-executing run whose review status name differs from COLUMN_AI_REVIEW", async () => {
    // Same retention, but COLUMN_AI_REVIEW names the transition ("Review") and
    // the status it lands in is localized ("Weryfikacja"). Comparing display
    // names misses, so the reconciler would cancel a run that is still
    // publishing, undoing the webhook's own review-destination exemption.
    const bound = entry();
    const runRegistry = registry([bound]);
    mockGetRun.mockReturnValue({ status: Promise.resolve("running") });
    mockHasDurableRunPublication.mockResolvedValue(true);
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(
        new Set(),
        runRegistry,
        issueTracker("Weryfikacja", "PROJ-1", {
          trackerStatusId: "11418",
          reviewDestination: { id: "11418", name: "Weryfikacja" },
        }),
        undefined,
        undefined,
        undefined,
        mockDb,
      ),
    ).toEqual({ cancelled: 0, cleaned: 0 });
    expect(mockCancelRunDetailed).not.toHaveBeenCalled();
  });

  it("cancels an AI Review transition when the exact run has no durable publication", async () => {
    const bound = entry();
    const runRegistry = registry([bound]);
    mockGetRun.mockReturnValue({ status: Promise.resolve("running") });
    mockCancelRunDetailed.mockResolvedValue({ cancelled: true, released: true });
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(
        new Set(),
        runRegistry,
        issueTracker("Review"),
        undefined,
        undefined,
        undefined,
        mockDb,
      ),
    ).toEqual({ cancelled: 1, cleaned: 0 });
    expect(mockHasDurableRunPublication).toHaveBeenCalledWith(expect.anything(), "run-1");
    expect(mockCancelRunDetailed).toHaveBeenCalledWith(
      "PROJ-1",
      "run-1",
      runRegistry,
      expect.anything(),
      undefined,
      undefined,
      "Jira AI Review transition before durable PR publication evidence",
    );
  });

  it("retains an AI Review transition when the exact run's success is recorded", async () => {
    const bound = entry();
    const runRegistry = registry([bound]);
    mockGetRun.mockReturnValue({ status: Promise.resolve("running") });
    mockIsRunRecordedSucceeded.mockResolvedValue(true);
    const { reconcileRuns } = await import("./reconcile.js");

    await expect(
      reconcileRuns(
        new Set(),
        runRegistry,
        issueTracker("Review"),
        undefined,
        undefined,
        undefined,
        mockDb,
      ),
    ).resolves.toEqual({ cancelled: 0, cleaned: 0 });
    expect(mockCancelRunDetailed).not.toHaveBeenCalled();
    expect(mockHasDurableRunPublication).not.toHaveBeenCalled();
  });

  it("retains an AI Review owner when durable evidence lookup fails", async () => {
    const bound = entry();
    const runRegistry = registry([bound]);
    mockGetRun.mockReturnValue({ status: Promise.resolve("running") });
    mockHasDurableRunPublication.mockRejectedValue(new Error("db down"));
    const { reconcileRuns } = await import("./reconcile.js");

    await expect(
      reconcileRuns(
        new Set(),
        runRegistry,
        issueTracker("Review"),
        undefined,
        undefined,
        undefined,
        mockDb,
      ),
    ).resolves.toEqual({ cancelled: 0, cleaned: 0 });
    expect(mockCancelRunDetailed).not.toHaveBeenCalled();
  });

  it("still cancels a still-executing run pulled to a status that is not the review destination", async () => {
    const bound = entry();
    const runRegistry = registry([bound]);
    mockGetRun.mockReturnValue({ status: Promise.resolve("running") });
    mockCancelRunDetailed.mockResolvedValue({ cancelled: true, released: true });
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(
        new Set(),
        runRegistry,
        issueTracker("Gotowe", "PROJ-1", {
          trackerStatusId: "10002",
          reviewDestination: { id: "11418", name: "Weryfikacja" },
        }),
      ),
    ).toEqual({ cancelled: 1, cleaned: 0 });
    expect(mockCancelRunDetailed).toHaveBeenCalledOnce();
  });

  it("still releases an AI Review ticket's owner once its world run is terminal", async () => {
    // Normal post-success janitor duty: the run completed, its ticket sits in
    // AI Review, and the orphan path's already-terminal cancellation releases
    // the exact owner as before.
    const bound = entry();
    const runRegistry = registry([bound]);
    mockGetRun.mockReturnValue({ status: Promise.resolve("completed") });
    mockHasDurableRunPublication.mockResolvedValue(true);
    mockCancelRunDetailed.mockResolvedValue({ cancelled: true, released: true });
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(
        new Set(),
        runRegistry,
        issueTracker("Review"),
        undefined,
        undefined,
        undefined,
        mockDb,
      ),
    ).toEqual({ cancelled: 1, cleaned: 0 });
    expect(mockCancelRunDetailed).toHaveBeenCalledOnce();
  });

  it("releases an already-terminal orphaned run without emitting a canceled notification", async () => {
    // The run genuinely failed (or completed) on its own before the
    // reconciler observed it. cancelRunDetailed's already-terminal outcome
    // must still release the claim, but must not relabel that failure as a
    // fresh "canceled" event for operators.
    const bound = entry();
    const runRegistry = registry([bound]);
    mockCancelRunDetailed.mockResolvedValue({
      cancelled: true,
      released: true,
      alreadyTerminal: true,
    });
    const onCancelled = vi.fn();
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(new Set(), runRegistry, issueTracker("Done"), onCancelled),
    ).toEqual({ cancelled: 1, cleaned: 0 });
    expect(onCancelled).not.toHaveBeenCalled();
  });

  it("still emits a canceled notification for a genuinely running orphaned run", async () => {
    const bound = entry();
    const runRegistry = registry([bound]);
    mockCancelRunDetailed.mockResolvedValue({ cancelled: true, released: true });
    const onCancelled = vi.fn();
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(new Set(), runRegistry, issueTracker("Done"), onCancelled),
    ).toEqual({ cancelled: 1, cleaned: 0 });
    expect(onCancelled).toHaveBeenCalledWith("PROJ-1", "orphaned_run");
  });

  it("releases an already-terminal closing ticket claim without emitting a canceled notification", async () => {
    // Same already-terminal race as the orphan path, but observed while the
    // claim is in the durable "cancelling" retry state.
    const closing = entry({ state: "cancelling" });
    const runRegistry = registry([closing]);
    const tracker = issueTracker("AI");
    mockCancelRunDetailed.mockResolvedValue({
      cancelled: true,
      released: true,
      alreadyTerminal: true,
    });
    const onCancelled = vi.fn();
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(
        new Set(["PROJ-1"]),
        runRegistry,
        tracker,
        onCancelled,
        undefined,
        new Set([closing.subjectKey]),
      ),
    ).toEqual({ cancelled: 1, cleaned: 0 });
    expect(onCancelled).not.toHaveBeenCalled();
  });

  it("never releases an owner solely because the Workflow status API is unreachable", async () => {
    const bound = entry({ subjectKey: "pr:github:acme/app#8", ticketKey: null, kind: "pr_trigger" });
    const runRegistry = registry([bound]);
    mockGetRun.mockImplementation(() => {
      throw new Error("gone");
    });
    const onReleased = vi.fn();
    const { reconcileRuns } = await import("./reconcile.js");

    await reconcileRuns(new Set(), runRegistry, undefined, undefined, onReleased);
    await reconcileRuns(new Set(), runRegistry, undefined, undefined, onReleased);
    await reconcileRuns(new Set(), runRegistry, undefined, undefined, onReleased);
    await reconcileRuns(new Set(), runRegistry, undefined, undefined, onReleased);

    expect(runRegistry.release).not.toHaveBeenCalled();
    expect(onReleased).not.toHaveBeenCalled();
  });

  it("does not report or drain an orphan when Workflow cancellation was not confirmed", async () => {
    const bound = entry();
    const runRegistry = registry([bound]);
    mockCancelRunDetailed.mockResolvedValue({ cancelled: false, released: false });
    const onCancelled = vi.fn();
    const onReleased = vi.fn();
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(
        new Set(),
        runRegistry,
        issueTracker("Done"),
        onCancelled,
        onReleased,
      ),
    ).toEqual({ cancelled: 0, cleaned: 0 });
    expect(onCancelled).not.toHaveBeenCalled();
    expect(onReleased).not.toHaveBeenCalled();
  });
});
