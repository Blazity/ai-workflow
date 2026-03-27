import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";

const mockGetRun = vi.fn();
vi.mock("workflow/api", () => ({
  getRun: (...args: any[]) => mockGetRun(...args),
}));

function makeRegistry(overrides: Partial<RunRegistryAdapter> = {}): RunRegistryAdapter {
  return {
    claim: vi.fn(),
    register: vi.fn(),
    getRunId: vi.fn(),
    unregister: overrides.unregister ?? vi.fn().mockResolvedValue(undefined),
    listAll: vi.fn(),
  };
}

describe("cancelRun", () => {
  beforeEach(() => vi.clearAllMocks());

  it("cancels the run and unregisters", async () => {
    const mockCancel = vi.fn().mockResolvedValue(undefined);
    mockGetRun.mockReturnValue({ cancel: mockCancel });
    const registry = makeRegistry();

    const { cancelRun } = await import("./cancel-run.js");
    const result = await cancelRun("PROJ-1", "run_abc", registry);

    expect(result).toBe(true);
    expect(mockGetRun).toHaveBeenCalledWith("run_abc");
    expect(mockCancel).toHaveBeenCalled();
    expect(registry.unregister).toHaveBeenCalledWith("PROJ-1");
  });

  it("returns false and still unregisters when cancel throws", async () => {
    mockGetRun.mockReturnValue({
      cancel: vi.fn().mockRejectedValue(new Error("run gone")),
    });
    const registry = makeRegistry();

    const { cancelRun } = await import("./cancel-run.js");
    const result = await cancelRun("PROJ-1", "run_abc", registry);

    expect(result).toBe(false);
    expect(registry.unregister).toHaveBeenCalledWith("PROJ-1");
  });

  it("is idempotent — second call on same ticket returns false without throwing", async () => {
    mockGetRun.mockReturnValue({
      cancel: vi.fn().mockRejectedValue(new Error("already cancelled")),
    });
    const unregister = vi.fn().mockResolvedValue(undefined);
    const registry = makeRegistry({ unregister });

    const { cancelRun } = await import("./cancel-run.js");
    await cancelRun("PROJ-1", "run_abc", registry);
    const result = await cancelRun("PROJ-1", "run_abc", registry);

    expect(result).toBe(false);
    expect(unregister).toHaveBeenCalledTimes(2);
  });
});
