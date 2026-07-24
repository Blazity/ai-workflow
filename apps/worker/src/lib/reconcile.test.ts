import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ActiveRunEntry,
  FailedTicketMeta,
  RunRegistryAdapter,
} from "../adapters/run-registry/types.js";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";

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
const mockCancelRun = vi.fn();
const mockCancelSubjectRun = vi.fn();
const mockStopSandboxesByIds = vi.fn();
const mockListWorkflowSteps = vi.fn();
vi.mock("workflow/api", () => ({ getRun: (...args: any[]) => mockGetRun(...args) }));
vi.mock("workflow/runtime", () => ({
  getWorld: () => ({
    steps: { list: (...args: any[]) => mockListWorkflowSteps(...args) },
  }),
}));
vi.mock("./cancel-run.js", () => ({
  cancelRun: (...args: any[]) => mockCancelRun(...args),
  cancelSubjectRun: (...args: any[]) => mockCancelSubjectRun(...args),
}));
vi.mock("../sandbox/stop-ticket-sandboxes.js", () => ({
  stopSandboxesByIds: (...args: any[]) => mockStopSandboxesByIds(...args),
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

function issueTracker(status = "AI", identifier = "PROJ-1"): IssueTrackerAdapter {
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
    }),
    moveTicket: vi.fn(),
    postComment: vi.fn(),
    searchTickets: vi.fn(),
  };
}

describe("reconcileRuns owner-CAS recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStopSandboxesByIds.mockResolvedValue(2);
    mockListWorkflowSteps.mockResolvedValue({
      data: [],
      cursor: null,
      hasMore: false,
    });
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
    expect(mockCancelRun).not.toHaveBeenCalled();
  });

  it("lets retained clarification protection win over an older terminal successor", async () => {
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
    expect(mockCancelRun).not.toHaveBeenCalled();
    expect(runRegistry.release).not.toHaveBeenCalled();
  });

  it("terminal-cleans a consumed clarification successor instead of retaining it forever", async () => {
    const successor = entry();
    const runRegistry = registry([successor]);
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
        new Set([successor.subjectKey]),
      ),
    ).resolves.toEqual({ cancelled: 0, cleaned: 1 });
    expect(mockCancelRun).not.toHaveBeenCalled();
    expect(runRegistry.release).toHaveBeenCalledWith(
      successor.subjectKey,
      successor.ownerToken,
      successor.runId,
    );
    expect(onReleased).toHaveBeenCalledWith(successor.subjectKey);
  });

  it("keeps a running consumed clarification successor without orphan-cancelling it outside AI", async () => {
    const successor = entry();
    const runRegistry = registry([successor]);
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
        new Set([successor.subjectKey]),
      ),
    ).resolves.toEqual({ cancelled: 0, cleaned: 0 });
    expect(mockCancelRun).not.toHaveBeenCalled();
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
    expect(mockCancelRun).not.toHaveBeenCalled();
  });

  it("does not strand an expired parked clarification owner outside generic cleanup", async () => {
    const parked = entry({ state: "parked" });
    const runRegistry = registry([parked]);
    const tracker = issueTracker("Done");
    mockCancelRun.mockResolvedValue(true);
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(new Set(), runRegistry, tracker),
    ).toEqual({ cancelled: 1, cleaned: 0 });
    expect(mockCancelRun).toHaveBeenCalledWith(
      "PROJ-1",
      "run-1",
      runRegistry,
      tracker,
      undefined,
      undefined,
      "Orphaned run cancelled by reconciler: ticket no longer in the AI column",
    );
  });

  it("retries a closing ticket claim and confirms Backlog before it can be released", async () => {
    const closing = entry({ state: "cancelling" });
    const runRegistry = registry([closing]);
    const tracker = issueTracker("AI");
    mockCancelRun.mockResolvedValue(true);
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
    expect(mockCancelRun).toHaveBeenCalledWith(
      "PROJ-1",
      { ownerToken: "owner-a", runId: "run-1" },
      runRegistry,
      tracker,
      "Backlog",
      onReleased,
      "Orphaned run cancelled by reconciler: ticket no longer in the AI column",
    );
  });

  it("passes Jira to a closing ticket retry outside AI so durable post-drain cleanup can finish", async () => {
    const closing = entry({ state: "cancelling" });
    const runRegistry = registry([closing]);
    const tracker = issueTracker("Done");
    mockCancelRun.mockResolvedValue(true);
    const onReleased = vi.fn();
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(new Set(), runRegistry, tracker, undefined, onReleased),
    ).toEqual({ cancelled: 1, cleaned: 0 });
    expect(mockCancelRun).toHaveBeenCalledWith(
      "PROJ-1",
      { ownerToken: "owner-a", runId: "run-1" },
      runRegistry,
      tracker,
      undefined,
      onReleased,
      "Orphaned run cancelled by reconciler: ticket no longer in the AI column",
    );
  });

  it("retries a closing ticketless claim without Jira mutation", async () => {
    const closing = entry({
      subjectKey: "pr:github:acme/app#9",
      ticketKey: null,
      kind: "pr_trigger",
      state: "cancelling",
    });
    const runRegistry = registry([closing]);
    mockCancelSubjectRun.mockResolvedValue(true);
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
    expect(mockCancelSubjectRun).toHaveBeenCalledWith(
      closing.subjectKey,
      { ownerToken: "owner-a", runId: "run-1" },
      runRegistry,
      onReleased,
      "Orphaned run cancelled by reconciler: ticket no longer in the AI column",
    );
  });

  it("passes owner-gated drain through cancellation for a ticket that left AI", async () => {
    const bound = entry();
    const runRegistry = registry([bound]);
    const tracker = issueTracker("Done");
    const onReleased = vi.fn();
    mockCancelRun.mockImplementation(async (...args: unknown[]) => {
      const releaseCallback = args[5] as (subjectKey: string) => Promise<void>;
      await releaseCallback(bound.subjectKey);
      return true;
    });
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(new Set(), runRegistry, tracker, undefined, onReleased),
    ).toEqual({ cancelled: 1, cleaned: 0 });
    expect(mockCancelRun).toHaveBeenCalledWith(
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
    mockCancelRun.mockResolvedValue(true);
    const { reconcileRuns } = await import("./reconcile.js");

    await expect(
      reconcileRuns(new Set(), runRegistry, issueTracker("Done")),
    ).resolves.toEqual({ cancelled: 1, cleaned: 0 });
    expect(mockCancelRun).toHaveBeenCalledWith(
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
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(new Set(), runRegistry, issueTracker("Review")),
    ).toEqual({ cancelled: 0, cleaned: 0 });
    expect(mockCancelRun).not.toHaveBeenCalled();
    expect(runRegistry.release).not.toHaveBeenCalled();
  });

  it("still releases an AI Review ticket's owner once its world run is terminal", async () => {
    // Normal post-success janitor duty: the run completed, its ticket sits in
    // AI Review, and the orphan path's already-terminal cancellation releases
    // the exact owner as before.
    const bound = entry();
    const runRegistry = registry([bound]);
    mockGetRun.mockReturnValue({ status: Promise.resolve("completed") });
    mockCancelRun.mockResolvedValue(true);
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(new Set(), runRegistry, issueTracker("Review")),
    ).toEqual({ cancelled: 1, cleaned: 0 });
    expect(mockCancelRun).toHaveBeenCalledOnce();
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
    mockCancelRun.mockResolvedValue(false);
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
