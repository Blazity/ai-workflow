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

function makeRegistry(
  runs: Array<{ ticketKey: string; runId: string }> = [],
  failed: Array<{ ticketKey: string; meta: { runId: string; error: string; failedAt: string } }> = [],
): RunRegistryAdapter {
  return {
    claim: vi.fn(),
    register: vi.fn(),
    getRunId: vi.fn(),
    unregister: vi.fn().mockResolvedValue(undefined),
    listAll: vi.fn().mockResolvedValue(runs),
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
    postComment: vi.fn(),
    searchTickets: vi.fn(),
    ...overrides,
  };
}

describe("reconcileRuns", () => {
  beforeEach(() => vi.clearAllMocks());

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

  it("cleans stale claiming entries", async () => {
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    const registry = makeRegistry([
      { ticketKey: "PROJ-1", runId: `claiming:${tenMinAgo}` },
    ]);
    const { reconcileRuns } = await import("./reconcile.js");

    const result = await reconcileRuns(new Set(["PROJ-1"]), registry);

    expect(result).toEqual({ cancelled: 0, cleaned: 1 });
    expect(registry.unregister).toHaveBeenCalledWith("PROJ-1");
  });


  it("cancels fresh claiming entries for tickets that left AI column", async () => {
    const registry = makeRegistry([
      { ticketKey: "PROJ-1", runId: `claiming:${Date.now()}` },
    ]);
    const { reconcileRuns } = await import("./reconcile.js");

    // PROJ-1 is NOT in the AI column set
    const result = await reconcileRuns(new Set(), registry);

    expect(result).toEqual({ cancelled: 1, cleaned: 0 });
    expect(registry.unregister).toHaveBeenCalledWith("PROJ-1");
    expect(mockCancelRun).not.toHaveBeenCalled();
  });

  it("keeps fresh claiming entry when missing from JQL snapshot but Jira still says AI", async () => {
    const registry = makeRegistry([
      { ticketKey: "PROJ-1", runId: `claiming:${Date.now()}` },
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
});
