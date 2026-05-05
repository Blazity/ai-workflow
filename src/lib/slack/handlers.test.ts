import { describe, it, expect, vi } from "vitest";
import type { RunRegistryAdapter } from "../../adapters/run-registry/types.js";

vi.mock("../../../env.js", () => ({ env: {} }));

const { handleCancel, handleList, handleStatus } = await import("./handlers.js");

const JIRA_BASE_URL = "https://example.atlassian.net";

function makeRegistry(overrides: Partial<RunRegistryAdapter> = {}): RunRegistryAdapter {
  return {
    claim: vi.fn(),
    register: vi.fn(),
    getRunId: overrides.getRunId ?? vi.fn().mockResolvedValue(null),
    unregister: vi.fn().mockResolvedValue(undefined),
    listAll: overrides.listAll ?? vi.fn().mockResolvedValue([]),
    registerSandbox: vi.fn().mockResolvedValue(undefined),
    getSandboxId: overrides.getSandboxId ?? vi.fn().mockResolvedValue(null),
    getEntryCreatedAt: vi.fn().mockResolvedValue(null),
    markFailed: vi.fn().mockResolvedValue(undefined),
    isTicketFailed: vi.fn().mockResolvedValue(false),
    listAllFailed: vi.fn().mockResolvedValue([]),
    clearFailedMark: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("handleList", () => {
  it("returns the empty-state message when no entries", async () => {
    const registry = makeRegistry({ listAll: vi.fn().mockResolvedValue([]) });
    expect(await handleList(registry, JIRA_BASE_URL)).toBe("No active workflows.");
  });

  it("filters out claiming sentinels", async () => {
    const registry = makeRegistry({
      listAll: vi.fn().mockResolvedValue([
        { ticketKey: "AWT-1", runId: "run_real" },
        { ticketKey: "AWT-2", runId: "claiming:1700000000000" },
      ]),
    });
    const out = await handleList(registry, JIRA_BASE_URL);
    expect(out).toContain("AWT-1");
    expect(out).toContain("run_real");
    expect(out).not.toContain("AWT-2");
  });

  it("returns empty-state message when only claiming sentinels exist", async () => {
    const registry = makeRegistry({
      listAll: vi.fn().mockResolvedValue([
        { ticketKey: "AWT-1", runId: "claiming:1700000000000" },
      ]),
    });
    expect(await handleList(registry, JIRA_BASE_URL)).toBe("No active workflows.");
  });
});

describe("handleStatus", () => {
  it("reports not tracked when no runId", async () => {
    const registry = makeRegistry({
      getRunId: vi.fn().mockResolvedValue(null),
    });
    expect(await handleStatus(registry, "AWT-99", JIRA_BASE_URL)).toContain(
      "not tracked",
    );
  });

  it("reports runId + sandbox: yes when sandbox is registered", async () => {
    const registry = makeRegistry({
      getRunId: vi.fn().mockResolvedValue("run_a"),
      getSandboxId: vi.fn().mockResolvedValue("sbx_z"),
    });
    expect(await handleStatus(registry, "AWT-1", JIRA_BASE_URL)).toContain(
      "runId `run_a`, sandbox: yes",
    );
  });

  it("reports sandbox: no when no sandbox", async () => {
    const registry = makeRegistry({
      getRunId: vi.fn().mockResolvedValue("run_a"),
      getSandboxId: vi.fn().mockResolvedValue(null),
    });
    expect(await handleStatus(registry, "AWT-1", JIRA_BASE_URL)).toContain(
      "sandbox: no",
    );
  });
});

describe("handleCancel", () => {
  it("returns 'no active run' when registry has no entry", async () => {
    const registry = makeRegistry({ getRunId: vi.fn().mockResolvedValue(null) });
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

  it("warns the user when the entry is a claiming sentinel and stops the sandbox", async () => {
    const registry = makeRegistry({
      getRunId: vi.fn().mockResolvedValue("claiming:1700000000000"),
      getSandboxId: vi.fn().mockResolvedValue("sbx_z"),
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
    expect(stopSandboxes).toHaveBeenCalledWith("AWT-1", "sbx_z");
    expect(registry.unregister).toHaveBeenCalledWith("AWT-1");
    expect(cancelRunFn).not.toHaveBeenCalled();
  });

  it("calls cancelRun with ticket key + runId + registry, and reports success", async () => {
    const registry = makeRegistry({
      getRunId: vi.fn().mockResolvedValue("run_a"),
    });
    const cancelRunFn = vi.fn().mockResolvedValue(true);
    const stopSandboxes = vi.fn();
    const out = await handleCancel(
      registry,
      "AWT-1",
      cancelRunFn,
      stopSandboxes,
    );
    expect(cancelRunFn).toHaveBeenCalledWith("AWT-1", "run_a", registry);
    expect(out).toContain("Cancelled");
    expect(out).toContain("AWT-1");
  });

  it("reports cancel-failed-but-cleanup-done when cancelRun returns false", async () => {
    const registry = makeRegistry({
      getRunId: vi.fn().mockResolvedValue("run_a"),
    });
    const cancelRunFn = vi.fn().mockResolvedValue(false);
    const out = await handleCancel(registry, "AWT-1", cancelRunFn, vi.fn());
    expect(out).toContain("AWT-1");
    expect(out.toLowerCase()).toContain("could not");
  });
});
