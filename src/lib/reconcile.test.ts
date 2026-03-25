import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";

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
): RunRegistryAdapter {
  return {
    claim: vi.fn(),
    register: vi.fn(),
    getRunId: vi.fn(),
    unregister: vi.fn().mockResolvedValue(undefined),
    listAll: vi.fn().mockResolvedValue(runs),
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

  it("cleans unreachable runs (getRun throws)", async () => {
    const registry = makeRegistry([
      { ticketKey: "PROJ-1", runId: "run_ghost" },
    ]);
    mockGetRun.mockReturnValue({
      get status() { return Promise.reject(new Error("not found")); },
    });
    const { reconcileRuns } = await import("./reconcile.js");

    const result = await reconcileRuns(new Set(["PROJ-1"]), registry);

    expect(result).toEqual({ cancelled: 0, cleaned: 1 });
    expect(registry.unregister).toHaveBeenCalledWith("PROJ-1");
  });
});
