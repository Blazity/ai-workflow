import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ActiveRunEntry,
  FailedTicketMeta,
  RunRegistryAdapter,
} from "../adapters/run-registry/types.js";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";

vi.mock("../../env.js", () => ({
  env: { JIRA_PROJECT_KEY: "PROJ", COLUMN_AI: "AI" },
}));

const mockGetRun = vi.fn();
const mockCancelRun = vi.fn();
const mockStopSandboxesByIds = vi.fn();
vi.mock("workflow/api", () => ({ getRun: (...args: any[]) => mockGetRun(...args) }));
vi.mock("./cancel-run.js", () => ({ cancelRun: (...args: any[]) => mockCancelRun(...args) }));
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

  it("keeps the exact bound predecessor while a durable clarification is pending", async () => {
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
      ),
    ).toEqual({ cancelled: 0, cleaned: 0 });
    expect(mockGetRun).not.toHaveBeenCalled();
    expect(mockCancelRun).not.toHaveBeenCalled();
    expect(runRegistry.release).not.toHaveBeenCalled();
  });

  it("passes owner-gated drain through cancellation for a ticket that left AI", async () => {
    const bound = entry();
    const runRegistry = registry([bound]);
    const onReleased = vi.fn();
    mockCancelRun.mockImplementation(async (...args: unknown[]) => {
      const releaseCallback = args[5] as (subjectKey: string) => Promise<void>;
      await releaseCallback(bound.subjectKey);
      return true;
    });
    const { reconcileRuns } = await import("./reconcile.js");

    expect(
      await reconcileRuns(new Set(), runRegistry, issueTracker("Done"), undefined, onReleased),
    ).toEqual({ cancelled: 1, cleaned: 0 });
    expect(mockCancelRun).toHaveBeenCalledWith(
      "PROJ-1",
      "run-1",
      runRegistry,
      undefined,
      undefined,
      onReleased,
    );
    expect(onReleased).toHaveBeenCalledWith(bound.subjectKey);
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
