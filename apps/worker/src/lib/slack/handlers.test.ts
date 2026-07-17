import { describe, it, expect, vi } from "vitest";
import type {
  ActiveRunEntry,
  RunRegistryAdapter,
} from "../../adapters/run-registry/types.js";

vi.mock("../../../env.js", () => ({ env: {} }));

const { handleCancel, handleList, handleStatus } = await import("./handlers.js");

const JIRA_BASE_URL = "https://example.atlassian.net";

function makeRegistry(overrides: Partial<RunRegistryAdapter> = {}): RunRegistryAdapter {
  return {
    reserve: vi.fn(),
    bindRun: vi.fn(),
    handoff: vi.fn(),
    get: overrides.get ?? vi.fn().mockResolvedValue(null),
    releaseReservation: overrides.releaseReservation ?? vi.fn().mockResolvedValue(true),
    release: vi.fn(),
    listAll: overrides.listAll ?? vi.fn().mockResolvedValue([]),
    registerSandbox: vi.fn().mockResolvedValue(undefined),
    listSandboxes: overrides.listSandboxes ?? vi.fn().mockResolvedValue([]),
    markFailed: vi.fn().mockResolvedValue(undefined),
    isTicketFailed: vi.fn().mockResolvedValue(false),
    listAllFailed: vi.fn().mockResolvedValue([]),
    clearFailedMark: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function active(
  ticketKey: string,
  overrides: Partial<ActiveRunEntry> = {},
): ActiveRunEntry {
  return {
    subjectKey: `ticket:jira:${ticketKey}`,
    ticketKey,
    ownerToken: `owner:${ticketKey}`,
    runId: `run:${ticketKey}`,
    state: "bound",
    kind: "ticket",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("handleList", () => {
  it("returns the empty-state message when no entries", async () => {
    const registry = makeRegistry({ listAll: vi.fn().mockResolvedValue([]) });
    expect(await handleList(registry, JIRA_BASE_URL)).toBe("No active workflows.");
  });

  it("filters out unbound reservations", async () => {
    const registry = makeRegistry({
      listAll: vi.fn().mockResolvedValue([
        active("AWT-1", { runId: "run_real" }),
        active("AWT-2", { state: "reserved", runId: null }),
      ]),
    });
    const out = await handleList(registry, JIRA_BASE_URL);
    expect(out).toContain("AWT-1");
    expect(out).toContain("run_real");
    expect(out).not.toContain("AWT-2");
  });

  it("returns empty-state message when only reservations exist", async () => {
    const registry = makeRegistry({
      listAll: vi.fn().mockResolvedValue([
        active("AWT-1", { state: "reserved", runId: null }),
      ]),
    });
    expect(await handleList(registry, JIRA_BASE_URL)).toBe("No active workflows.");
  });
});

describe("handleStatus", () => {
  it("reports not tracked when no runId", async () => {
    const registry = makeRegistry({
      get: vi.fn().mockResolvedValue(null),
    });
    expect(await handleStatus(registry, "AWT-99", JIRA_BASE_URL)).toContain(
      "not tracked",
    );
  });

  it("reports runId + sandbox: yes when sandbox is registered", async () => {
    const registry = makeRegistry({
      get: vi.fn().mockResolvedValue(active("AWT-1", { runId: "run_a" })),
      listSandboxes: vi.fn().mockResolvedValue(["sbx_z"]),
    });
    expect(await handleStatus(registry, "AWT-1", JIRA_BASE_URL)).toContain(
      "runId `run_a`, sandbox: yes",
    );
  });

  it("reports sandbox: no when no sandbox", async () => {
    const registry = makeRegistry({
      get: vi.fn().mockResolvedValue(active("AWT-1", { runId: "run_a" })),
      listSandboxes: vi.fn().mockResolvedValue([]),
    });
    expect(await handleStatus(registry, "AWT-1", JIRA_BASE_URL)).toContain(
      "sandbox: no",
    );
  });
});

describe("handleCancel", () => {
  it("returns 'no active run' when registry has no entry", async () => {
    const registry = makeRegistry({ get: vi.fn().mockResolvedValue(null) });
    const cancelRunFn = vi.fn();
    const stopSandboxes = vi.fn();
    const out = await handleCancel(
      registry,
      "AWT-1",
      cancelRunFn,
      stopSandboxes,
    );
    expect(out).toContain("No active run");
    expect(out).toContain("AWT-1");
    expect(cancelRunFn).not.toHaveBeenCalled();
    expect(stopSandboxes).not.toHaveBeenCalled();
  });

  it("warns the user when the entry is reserved and stops every owned sandbox", async () => {
    const registry = makeRegistry({
      get: vi.fn().mockResolvedValue(active("AWT-1", { state: "reserved", runId: null })),
      listSandboxes: vi.fn().mockResolvedValue(["sbx_z", "sbx_child"]),
    });
    const cancelRunFn = vi.fn();
    const stopSandboxes = vi.fn().mockResolvedValue(1);
    const out = await handleCancel(
      registry,
      "AWT-1",
      cancelRunFn,
      stopSandboxes,
    );
    expect(out).toContain("mid-dispatch");
    expect(stopSandboxes).toHaveBeenCalledWith(["sbx_z", "sbx_child"]);
    expect(registry.releaseReservation).toHaveBeenCalledWith(
      "ticket:jira:AWT-1",
      "owner:AWT-1",
    );
    expect(cancelRunFn).not.toHaveBeenCalled();
  });

  it("calls cancelRun with ticket key + runId + registry, and reports success", async () => {
    const registry = makeRegistry({
      get: vi.fn().mockResolvedValue(active("AWT-1", { runId: "run_a" })),
    });
    const cancelRunFn = vi.fn().mockResolvedValue(true);
    const stopSandboxes = vi.fn();
    const out = await handleCancel(
      registry,
      "AWT-1",
      cancelRunFn,
      stopSandboxes,
    );
    expect(cancelRunFn).toHaveBeenCalledWith(
      "AWT-1",
      "run_a",
      registry,
      undefined,
      undefined,
    );
    expect(out).toContain("Cancelled");
    expect(out).toContain("AWT-1");
  });

  it("reports cancel-failed-but-cleanup-done when cancelRun returns false", async () => {
    const registry = makeRegistry({
      get: vi.fn().mockResolvedValue(active("AWT-1", { runId: "run_a" })),
    });
    const cancelRunFn = vi.fn().mockResolvedValue(false);
    const out = await handleCancel(registry, "AWT-1", cancelRunFn, vi.fn());
    expect(out).toContain("AWT-1");
    expect(out.toLowerCase()).toContain("could not");
  });
});
