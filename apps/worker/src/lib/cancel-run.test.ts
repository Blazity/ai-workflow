import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveRunEntry, RunRegistryAdapter } from "../adapters/run-registry/types.js";

const mockGetRun = vi.fn();
const mockStopSandboxesByIds = vi.fn();
vi.mock("workflow/api", () => ({
  getRun: (...args: any[]) => mockGetRun(...args),
}));
vi.mock("../sandbox/stop-ticket-sandboxes.js", () => ({
  stopSandboxesByIds: (...args: any[]) => mockStopSandboxesByIds(...args),
}));

function active(overrides: Partial<ActiveRunEntry> = {}): ActiveRunEntry {
  return {
    subjectKey: "ticket:jira:PROJ-1",
    ticketKey: "PROJ-1",
    ownerToken: "owner-a",
    runId: "run_abc",
    state: "bound",
    kind: "ticket",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeRegistry(entry: ActiveRunEntry | null = active()): RunRegistryAdapter {
  return {
    reserve: vi.fn(),
    bindRun: vi.fn(),
    handoff: vi.fn(),
    get: vi.fn().mockResolvedValue(entry),
    releaseReservation: vi.fn(),
    release: vi.fn().mockResolvedValue(true),
    listAll: vi.fn(),
    registerSandbox: vi.fn(),
    listSandboxes: vi.fn().mockResolvedValue(["sbx-parent", "sbx-child"]),
    markFailed: vi.fn(),
    isTicketFailed: vi.fn(),
    listAllFailed: vi.fn(),
    clearFailedMark: vi.fn(),
  };
}

describe("cancelRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStopSandboxesByIds.mockResolvedValue(2);
  });

  it("cancels the exact owner and stops all of its durable sandbox ids", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    mockGetRun.mockReturnValue({ cancel });
    const registry = makeRegistry();
    const onReleased = vi.fn().mockResolvedValue(undefined);

    const { cancelRun } = await import("./cancel-run.js");
    const result = await cancelRun("PROJ-1", "run_abc", registry, undefined, undefined, onReleased);

    expect(result).toBe(true);
    expect(mockStopSandboxesByIds).toHaveBeenCalledWith(["sbx-parent", "sbx-child"]);
    expect(registry.release).toHaveBeenCalledWith(
      "ticket:jira:PROJ-1",
      "owner-a",
      "run_abc",
    );
    expect(onReleased).toHaveBeenCalledWith("ticket:jira:PROJ-1");
  });

  it("cannot cancel or release a different bound owner", async () => {
    const registry = makeRegistry(active({ runId: "run_successor", ownerToken: "owner-b" }));

    const { cancelRun } = await import("./cancel-run.js");
    const result = await cancelRun("PROJ-1", "run_abc", registry);

    expect(result).toBe(false);
    expect(mockGetRun).not.toHaveBeenCalled();
    expect(registry.listSandboxes).not.toHaveBeenCalled();
    expect(registry.release).not.toHaveBeenCalled();
  });

  it("still performs exact cleanup and owner release when workflow cancellation fails", async () => {
    mockGetRun.mockReturnValue({ cancel: vi.fn().mockRejectedValue(new Error("run gone")) });
    const registry = makeRegistry();

    const { cancelRun } = await import("./cancel-run.js");
    const result = await cancelRun("PROJ-1", "run_abc", registry);

    expect(result).toBe(false);
    expect(mockStopSandboxesByIds).toHaveBeenCalledWith(["sbx-parent", "sbx-child"]);
    expect(registry.release).toHaveBeenCalledWith(
      "ticket:jira:PROJ-1",
      "owner-a",
      "run_abc",
    );
  });
});
