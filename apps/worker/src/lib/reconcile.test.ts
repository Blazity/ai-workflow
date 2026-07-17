import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  IssueTrackerNotFoundError,
  type IssueTrackerAdapter,
} from "../adapters/issue-tracker/types.js";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";

vi.mock("../../env.js", () => ({
  env: {
    JIRA_PROJECT_KEY: "PROJ",
    COLUMN_AI: "AI",
  },
}));

const mockGetRun = vi.fn();
vi.mock("workflow/api", () => ({
  getRun: (...args: any[]) => mockGetRun(...args),
}));

const mockCancelRun = vi.fn();
vi.mock("./cancel-run.js", () => ({
  cancelRun: (...args: any[]) => mockCancelRun(...args),
}));

const mockStopTicketSandboxes = vi.fn();
vi.mock("../sandbox/stop-ticket-sandboxes.js", () => ({
  stopTicketSandboxes: (...args: any[]) => mockStopTicketSandboxes(...args),
}));

function makeRegistry(
  runs: Array<{ ticketKey: string; runId: string; kind?: string }> = [],
  failed: Array<{ ticketKey: string; meta: { runId: string; error: string; failedAt: string } }> = [],
): RunRegistryAdapter {
  return {
    claim: vi.fn(),
    register: vi.fn(),
    getRunId: vi.fn(),
    unregister: vi.fn().mockResolvedValue(undefined),
    unregisterIfRunId: vi.fn().mockResolvedValue(undefined),
    listAll: vi.fn().mockResolvedValue(runs),
    registerSandbox: vi.fn().mockResolvedValue(undefined),
    getSandboxId: vi.fn().mockResolvedValue(null),
    getEntryCreatedAt: vi.fn().mockResolvedValue(null),
    markFailed: vi.fn().mockResolvedValue(undefined),
    isTicketFailed: vi.fn().mockResolvedValue(false),
    listAllFailed: vi.fn().mockResolvedValue(failed),
    clearFailedMark: vi.fn().mockResolvedValue(undefined),
  };
}

function makeIssueTracker(
  overrides: Partial<IssueTrackerAdapter> = {},
): IssueTrackerAdapter {
  return {
    fetchTicket: vi.fn(),
    moveTicket: vi.fn(),
    postComment: vi.fn().mockResolvedValue(null),
    searchTickets: vi.fn(),
    ...overrides,
  };
}

describe("reconcileRuns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStopTicketSandboxes.mockResolvedValue(0);
  });

  it("skips fresh claiming entries", async () => {
    const registry = makeRegistry([
      { ticketKey: "PROJ-1", runId: `claiming:${Date.now()}` },
    ]);
    const { reconcileRuns } = await import("./reconcile.js");

    const result = await reconcileRuns(new Set(["PROJ-1"]), registry);

    expect(result).toEqual({ cancelled: 0, cleaned: 0 });
    expect(registry.unregister).not.toHaveBeenCalled();
    expect(mockGetRun).not.toHaveBeenCalled();
    expect(mockCancelRun).not.toHaveBeenCalled();
  });

  it("cleans stale claiming entries and stops sandboxes", async () => {
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    const registry = makeRegistry([
      { ticketKey: "PROJ-1", runId: `claiming:${tenMinAgo}` },
    ]);
    const { reconcileRuns } = await import("./reconcile.js");

    const result = await reconcileRuns(new Set(["PROJ-1"]), registry);

    expect(result).toEqual({ cancelled: 0, cleaned: 1 });
    expect(registry.unregister).toHaveBeenCalledWith("PROJ-1");
    // A crash between dispatch.start() and dispatch.register() can leave
    // a live sandbox shadowed by a sentinel; reconcile must sweep it.
    expect(mockStopTicketSandboxes).toHaveBeenCalledWith("PROJ-1", null);
  });


  it("cancels aged claiming entries for tickets that left AI column and stops sandboxes", async () => {
    // Aged past the orphan grace (but not yet stale) so the cancel path runs.
    const oneMinAgo = Date.now() - 60 * 1000;
    const registry = makeRegistry([
      { ticketKey: "PROJ-1", runId: `claiming:${oneMinAgo}` },
    ]);
    const { reconcileRuns } = await import("./reconcile.js");

    // PROJ-1 is NOT in the AI column set
    const result = await reconcileRuns(new Set(), registry);

    expect(result).toEqual({ cancelled: 1, cleaned: 0 });
    expect(registry.unregister).toHaveBeenCalledWith("PROJ-1");
    expect(mockCancelRun).not.toHaveBeenCalled();
    expect(mockStopTicketSandboxes).toHaveBeenCalledWith("PROJ-1", null);
  });

  it("spares a fresh claiming entry outside the AI column during the orphan grace", async () => {
    // A resume dispatch holds the claim while the ticket is still in the backlog
    // and moves it into AI a beat later; a cron tick in that window must not kill
    // the claim. It is picked up on a later tick if the ticket really is orphaned.
    const registry = makeRegistry([
      { ticketKey: "PROJ-1", runId: `claiming:${Date.now()}` },
    ]);
    const { reconcileRuns } = await import("./reconcile.js");

    const result = await reconcileRuns(new Set(), registry);

    expect(result).toEqual({ cancelled: 0, cleaned: 0 });
    expect(registry.unregister).not.toHaveBeenCalled();
    expect(mockStopTicketSandboxes).not.toHaveBeenCalled();
  });

  it("keeps aged claiming entry when missing from JQL snapshot but Jira still says AI", async () => {
    const oneMinAgo = Date.now() - 60 * 1000;
    const registry = makeRegistry([
      { ticketKey: "PROJ-1", runId: `claiming:${oneMinAgo}` },
    ]);
    const issueTracker = makeIssueTracker({
      fetchTicket: vi.fn().mockResolvedValue({
        id: "id-1",
        identifier: "PROJ-1",
        title: "x",
        description: "",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
        trackerStatus: "AI",
      }),
    });
    const { reconcileRuns } = await import("./reconcile.js");

    const result = await reconcileRuns(new Set(), registry, issueTracker);

    expect(result).toEqual({ cancelled: 0, cleaned: 0 });
    expect(registry.unregister).not.toHaveBeenCalled();
  });

  it("cleans completed runs that are still in AI column", async () => {
    const registry = makeRegistry([
      { ticketKey: "PROJ-1", runId: "run_done" },
    ]);
    mockGetRun.mockReturnValue({ status: Promise.resolve("completed") });
    const { reconcileRuns } = await import("./reconcile.js");

    const result = await reconcileRuns(new Set(["PROJ-1"]), registry);

    expect(result).toEqual({ cancelled: 0, cleaned: 1 });
    expect(registry.unregister).toHaveBeenCalledWith("PROJ-1");
    expect(mockCancelRun).not.toHaveBeenCalled();
  });

  it("cleans failed runs", async () => {
    const registry = makeRegistry([
      { ticketKey: "PROJ-1", runId: "run_fail" },
    ]);
    mockGetRun.mockReturnValue({ status: Promise.resolve("failed") });
    const { reconcileRuns } = await import("./reconcile.js");

    const result = await reconcileRuns(new Set(["PROJ-1"]), registry);

    expect(result).toEqual({ cancelled: 0, cleaned: 1 });
  });

  it("leaves running runs in AI column alone", async () => {
    const registry = makeRegistry([
      { ticketKey: "PROJ-1", runId: "run_active" },
    ]);
    mockGetRun.mockReturnValue({ status: Promise.resolve("running") });
    const { reconcileRuns } = await import("./reconcile.js");

    const result = await reconcileRuns(new Set(["PROJ-1"]), registry);

    expect(result).toEqual({ cancelled: 0, cleaned: 0 });
    expect(registry.unregister).not.toHaveBeenCalled();
  });

  it("cancels runs for tickets that left AI column", async () => {
    const registry = makeRegistry([
      { ticketKey: "PROJ-1", runId: "run_stale" },
    ]);
    mockCancelRun.mockResolvedValue(true);
    const { reconcileRuns } = await import("./reconcile.js");

    const result = await reconcileRuns(new Set(), registry); // PROJ-1 not in AI column

    expect(result).toEqual({ cancelled: 1, cleaned: 0 });
    expect(mockCancelRun).toHaveBeenCalledWith("PROJ-1", "run_stale", registry);
  });

  it("emits cancel callback when run is cancelled in reconcile", async () => {
    const registry = makeRegistry([
      { ticketKey: "PROJ-1", runId: "run_stale" },
    ]);
    mockCancelRun.mockResolvedValue(true);
    const onTicketCancelled = vi.fn().mockResolvedValue(undefined);
    const { reconcileRuns } = await import("./reconcile.js");

    await reconcileRuns(new Set(), registry, undefined, onTicketCancelled);

    expect(onTicketCancelled).toHaveBeenCalledWith("PROJ-1", "orphaned_run");
  });

  it("keeps running run when missing from JQL snapshot but Jira still says AI", async () => {
    const registry = makeRegistry([
      { ticketKey: "PROJ-1", runId: "run_live" },
    ]);
    const issueTracker = makeIssueTracker({
      fetchTicket: vi.fn().mockResolvedValue({
        id: "id-1",
        identifier: "PROJ-1",
        title: "x",
        description: "",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
        trackerStatus: "AI",
      }),
    });
    const { reconcileRuns } = await import("./reconcile.js");

    const result = await reconcileRuns(new Set(), registry, issueTracker);

    expect(result).toEqual({ cancelled: 0, cleaned: 0 });
    expect(mockCancelRun).not.toHaveBeenCalled();
    expect(registry.unregister).not.toHaveBeenCalled();
  });

  it("cancels running run when ticket moved to a different project", async () => {
    const registry = makeRegistry([
      { ticketKey: "PROJ-1", runId: "run_live" },
    ]);
    mockCancelRun.mockResolvedValue(true);
    const issueTracker = makeIssueTracker({
      fetchTicket: vi.fn().mockResolvedValue({
        id: "id-1",
        identifier: "OTHER-1",
        projectKey: "OTHER",
        title: "x",
        description: "",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
        trackerStatus: "AI",
      }),
    });
    const { reconcileRuns } = await import("./reconcile.js");

    const result = await reconcileRuns(new Set(), registry, issueTracker);

    expect(result).toEqual({ cancelled: 1, cleaned: 0 });
    expect(mockCancelRun).toHaveBeenCalledWith("PROJ-1", "run_live", registry);
  });

  it("treats typed not-found as left column and cancels running run", async () => {
    const registry = makeRegistry([
      { ticketKey: "PROJ-1", runId: "run_live" },
    ]);
    mockCancelRun.mockResolvedValue(true);
    const issueTracker = makeIssueTracker({
      fetchTicket: vi.fn().mockRejectedValue(
        new IssueTrackerNotFoundError("ticket", "PROJ-1"),
      ),
    });
    const { reconcileRuns } = await import("./reconcile.js");

    const result = await reconcileRuns(new Set(), registry, issueTracker);

    expect(result).toEqual({ cancelled: 1, cleaned: 0 });
    expect(mockCancelRun).toHaveBeenCalledWith("PROJ-1", "run_live", registry);
  });

  it("keeps running run when orphan verification fails", async () => {
    const registry = makeRegistry([
      { ticketKey: "PROJ-1", runId: "run_live" },
    ]);
    const issueTracker = makeIssueTracker({
      fetchTicket: vi.fn().mockRejectedValue(new Error("Jira API error: 500 Internal Server Error")),
    });
    const { reconcileRuns } = await import("./reconcile.js");

    const result = await reconcileRuns(new Set(), registry, issueTracker);

    expect(result).toEqual({ cancelled: 0, cleaned: 0 });
    expect(mockCancelRun).not.toHaveBeenCalled();
    expect(registry.unregister).not.toHaveBeenCalled();
  });

  it("does not unregister on a single getRun failure (strike 1 of 3)", async () => {
    const registry = makeRegistry([
      { ticketKey: "PROJ-1", runId: "run_ghost" },
    ]);
    mockGetRun.mockReturnValue({
      get status() { return Promise.reject(new Error("not found")); },
    });
    const { reconcileRuns } = await import("./reconcile.js");

    // First failure — should NOT unregister (strike 1)
    const result = await reconcileRuns(new Set(["PROJ-1"]), registry);

    expect(result).toEqual({ cancelled: 0, cleaned: 0 });
    expect(registry.unregister).not.toHaveBeenCalled();
  });

  it("unregisters after 3 consecutive getRun failures", async () => {
    const registry = makeRegistry([
      { ticketKey: "PROJ-1", runId: "run_ghost" },
    ]);
    mockGetRun.mockReturnValue({
      get status() { return Promise.reject(new Error("not found")); },
    });
    const { reconcileRuns } = await import("./reconcile.js");

    // Strike 2 (strike 1 was in the previous test — same module instance)
    await reconcileRuns(new Set(["PROJ-1"]), registry);
    expect(registry.unregister).not.toHaveBeenCalled();

    // Strike 3 — should unregister now
    const result = await reconcileRuns(new Set(["PROJ-1"]), registry);

    expect(result).toEqual({ cancelled: 0, cleaned: 1 });
    expect(registry.unregister).toHaveBeenCalledWith("PROJ-1");
  });

  it("resets strike counter on successful getRun", async () => {
    const registry = makeRegistry([
      { ticketKey: "PROJ-1", runId: "run_flaky" },
    ]);
    const { reconcileRuns } = await import("./reconcile.js");

    // One failure — strike 1
    mockGetRun.mockReturnValue({
      get status() { return Promise.reject(new Error("transient")); },
    });
    await reconcileRuns(new Set(["PROJ-1"]), registry);
    expect(registry.unregister).not.toHaveBeenCalled();

    // Success — resets counter
    mockGetRun.mockReturnValue({ status: Promise.resolve("running") });
    await reconcileRuns(new Set(["PROJ-1"]), registry);
    expect(registry.unregister).not.toHaveBeenCalled();

    // Another failure — strike 1 again (not 2)
    mockGetRun.mockReturnValue({
      get status() { return Promise.reject(new Error("transient")); },
    });
    await reconcileRuns(new Set(["PROJ-1"]), registry);
    expect(registry.unregister).not.toHaveBeenCalled();
  });

  it("clears failed-ticket marker when ticket leaves AI column", async () => {
    const registry = makeRegistry([], [
      { ticketKey: "PROJ-1", meta: { runId: "run_a", error: "move failed", failedAt: "2026-04-02T10:00:00.000Z" } },
    ]);
    const { reconcileRuns } = await import("./reconcile.js");

    // PROJ-1 is NOT in AI column — human moved it out
    await reconcileRuns(new Set(), registry);

    expect(registry.clearFailedMark).toHaveBeenCalledWith("PROJ-1");
  });

  it("keeps failed-ticket marker when ticket is still in AI column", async () => {
    const registry = makeRegistry([], [
      { ticketKey: "PROJ-1", meta: { runId: "run_a", error: "move failed", failedAt: "2026-04-02T10:00:00.000Z" } },
    ]);
    const { reconcileRuns } = await import("./reconcile.js");

    // PROJ-1 still in AI column
    await reconcileRuns(new Set(["PROJ-1"]), registry);

    expect(registry.clearFailedMark).not.toHaveBeenCalled();
  });

  it("does NOT cancel a pr_trigger run when its ticket left the AI column", async () => {
    const registry = makeRegistry([
      { ticketKey: "PROJ-1", runId: "run_pr", kind: "pr_trigger" },
    ]);
    mockGetRun.mockReturnValue({ status: Promise.resolve("running") });
    const { reconcileRuns } = await import("./reconcile.js");

    // PROJ-1 is NOT in the AI column, but a pr_trigger run follows the PR.
    const result = await reconcileRuns(new Set(), registry);

    expect(result).toEqual({ cancelled: 0, cleaned: 0 });
    expect(mockCancelRun).not.toHaveBeenCalled();
    expect(registry.unregister).not.toHaveBeenCalled();
  });

  it("still cancels a ticket-kind run when its ticket left the AI column", async () => {
    const registry = makeRegistry([
      { ticketKey: "PROJ-1", runId: "run_stale", kind: "ticket" },
    ]);
    mockCancelRun.mockResolvedValue(true);
    const { reconcileRuns } = await import("./reconcile.js");

    const result = await reconcileRuns(new Set(), registry);

    expect(result).toEqual({ cancelled: 1, cleaned: 0 });
    expect(mockCancelRun).toHaveBeenCalledWith("PROJ-1", "run_stale", registry);
  });

  it("sweeps a terminal pr_trigger run even when its ticket is outside the AI column", async () => {
    const registry = makeRegistry([
      { ticketKey: "PROJ-1", runId: "run_done", kind: "pr_trigger" },
    ]);
    mockGetRun.mockReturnValue({ status: Promise.resolve("completed") });
    const { reconcileRuns } = await import("./reconcile.js");

    // Not in the AI column, but the dead-run sweep still cleans a finished run.
    const result = await reconcileRuns(new Set(), registry);

    expect(result).toEqual({ cancelled: 0, cleaned: 1 });
    expect(registry.unregister).toHaveBeenCalledWith("PROJ-1");
    expect(mockCancelRun).not.toHaveBeenCalled();
  });

  it("does NOT cancel a pr_trigger inflight claim when its ticket left the AI column", async () => {
    const registry = makeRegistry([
      { ticketKey: "PROJ-1", runId: `claiming:${Date.now()}`, kind: "pr_trigger" },
    ]);
    const { reconcileRuns } = await import("./reconcile.js");

    const result = await reconcileRuns(new Set(), registry);

    expect(result).toEqual({ cancelled: 0, cleaned: 0 });
    expect(registry.unregister).not.toHaveBeenCalled();
    expect(mockStopTicketSandboxes).not.toHaveBeenCalled();
  });

  it("still sweeps a stale pr_trigger inflight claim", async () => {
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    const registry = makeRegistry([
      { ticketKey: "PROJ-1", runId: `claiming:${tenMinAgo}`, kind: "pr_trigger" },
    ]);
    const { reconcileRuns } = await import("./reconcile.js");

    const result = await reconcileRuns(new Set(), registry);

    expect(result).toEqual({ cancelled: 0, cleaned: 1 });
    expect(registry.unregister).toHaveBeenCalledWith("PROJ-1");
  });
});
