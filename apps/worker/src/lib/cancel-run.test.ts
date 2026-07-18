import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveRunEntry, RunRegistryAdapter } from "../adapters/run-registry/types.js";

const mockGetRun = vi.fn();
const mockStopSandboxesByIds = vi.fn();
const mockTombstoneClarificationCancellation = vi.fn();
vi.mock("workflow/api", () => ({
  getRun: (...args: any[]) => mockGetRun(...args),
}));
vi.mock("../sandbox/stop-ticket-sandboxes.js", () => ({
  stopSandboxesByIds: (...args: any[]) => mockStopSandboxesByIds(...args),
}));
vi.mock("../db/client.js", () => ({ getDb: () => ({ db: true }) }));
vi.mock("../clarifications/store.js", () => ({
  tombstoneClarificationCancellation: (...args: any[]) =>
    mockTombstoneClarificationCancellation(...args),
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
    beginCancellation: vi.fn().mockResolvedValue(true),
    releaseCancellation: vi.fn().mockResolvedValue(true),
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
    mockTombstoneClarificationCancellation.mockResolvedValue({
      matched: false,
      successorOwnerToken: null,
    });
  });

  it("persists a clarification cancellation tombstone before releasing its owner", async () => {
    const order: string[] = [];
    mockGetRun.mockReturnValue({
      cancel: vi.fn().mockImplementation(async () => order.push("cancel")),
    });
    mockTombstoneClarificationCancellation.mockImplementation(async () => {
      order.push("tombstone");
      return { matched: false, successorOwnerToken: null };
    });
    const registry = makeRegistry();
    vi.mocked(registry.listSandboxes).mockImplementation(async () => {
      order.push("sandboxes");
      return [];
    });
    vi.mocked(registry.beginCancellation).mockImplementation(async () => {
      order.push("close");
      return true;
    });
    vi.mocked(registry.releaseCancellation).mockImplementation(async () => {
      order.push("release");
      return true;
    });

    const { cancelRun } = await import("./cancel-run.js");
    expect(
      await cancelRun(
        "PROJ-1",
        { ownerToken: "owner-a", runId: "run_abc" },
        registry,
      ),
    ).toBe(true);

    expect(mockTombstoneClarificationCancellation).toHaveBeenCalledWith(
      { db: true },
      {
        subjectKey: "ticket:jira:PROJ-1",
        ownerToken: "owner-a",
        runId: "run_abc",
      },
    );
    expect(order).toEqual([
      "tombstone",
      "close",
      "cancel",
      "sandboxes",
      "release",
    ]);
  });

  it("retains ownership when the clarification tombstone cannot be persisted", async () => {
    mockGetRun.mockReturnValue({ cancel: vi.fn().mockResolvedValue(undefined) });
    mockTombstoneClarificationCancellation.mockRejectedValue(new Error("database unavailable"));
    const registry = makeRegistry();

    const { cancelRun } = await import("./cancel-run.js");
    expect(await cancelRun("PROJ-1", "run_abc", registry)).toBe(false);

    expect(registry.listSandboxes).not.toHaveBeenCalled();
    expect(registry.releaseCancellation).not.toHaveBeenCalled();
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
    expect(registry.beginCancellation).toHaveBeenCalledWith(
      "ticket:jira:PROJ-1",
      "owner-a",
      "run_abc",
    );
    expect(registry.releaseCancellation).toHaveBeenCalledWith(
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
    expect(registry.releaseCancellation).not.toHaveBeenCalled();
  });

  it("keeps ownership and sandboxes when workflow cancellation is not confirmed", async () => {
    mockGetRun.mockReturnValue({ cancel: vi.fn().mockRejectedValue(new Error("run gone")) });
    const registry = makeRegistry();

    const { cancelRun } = await import("./cancel-run.js");
    const result = await cancelRun("PROJ-1", "run_abc", registry);

    expect(result).toBe(false);
    expect(mockStopSandboxesByIds).not.toHaveBeenCalled();
    expect(registry.releaseCancellation).not.toHaveBeenCalled();
  });

  it("retains the owner after cancellation when sandbox cleanup is unconfirmed", async () => {
    mockGetRun.mockReturnValue({ cancel: vi.fn().mockResolvedValue(undefined) });
    mockStopSandboxesByIds.mockRejectedValue(new Error("sandbox API unavailable"));
    const registry = makeRegistry();

    const { cancelRun } = await import("./cancel-run.js");
    expect(await cancelRun("PROJ-1", "run_abc", registry)).toBe(false);
    expect(registry.releaseCancellation).not.toHaveBeenCalled();
  });

  it("returns retryable failure when exact claim release is unconfirmed", async () => {
    mockGetRun.mockReturnValue({ cancel: vi.fn().mockResolvedValue(undefined) });
    const registry = makeRegistry();
    vi.mocked(registry.releaseCancellation).mockResolvedValue(false);

    const { cancelRun } = await import("./cancel-run.js");
    expect(await cancelRun("PROJ-1", "run_abc", registry)).toBe(false);
  });

  it("follows a clarification handoff and clears the reserved successor", async () => {
    const successor = active({
      ownerToken: "owner-successor",
      runId: null,
      state: "reserved",
    });
    mockTombstoneClarificationCancellation.mockResolvedValue({
      matched: true,
      successorOwnerToken: "owner-successor",
    });
    const registry = makeRegistry(successor);

    const { cancelRun } = await import("./cancel-run.js");
    expect(
      await cancelRun(
        "PROJ-1",
        { ownerToken: "owner-a", runId: "run_abc" },
        registry,
      ),
    ).toBe(true);
    expect(mockTombstoneClarificationCancellation).toHaveBeenCalledOnce();
    expect(mockGetRun).not.toHaveBeenCalled();
    expect(registry.beginCancellation).toHaveBeenCalledWith(
      "ticket:jira:PROJ-1",
      "owner-successor",
      null,
    );
    expect(registry.releaseCancellation).toHaveBeenCalledWith(
      "ticket:jira:PROJ-1",
      "owner-successor",
      null,
    );
  });

  it("durably tombstones a reserved clarification successor before releasing it", async () => {
    const order: string[] = [];
    const registry = makeRegistry(
      active({ ownerToken: "owner-successor", runId: null, state: "reserved" }),
    );
    mockTombstoneClarificationCancellation.mockImplementation(async () => {
      order.push("tombstone");
      return { matched: true, successorOwnerToken: "owner-successor" };
    });
    vi.mocked(registry.listSandboxes).mockImplementation(async () => {
      order.push("sandboxes");
      return [];
    });
    vi.mocked(registry.beginCancellation).mockImplementation(async () => {
      order.push("close");
      return true;
    });
    vi.mocked(registry.releaseCancellation).mockImplementation(async () => {
      order.push("release");
      return true;
    });

    const { cancelRun } = await import("./cancel-run.js");
    expect(
      await cancelRun(
        "PROJ-1",
        { ownerToken: "owner-successor", runId: null },
        registry,
      ),
    ).toBe(true);
    expect(mockGetRun).not.toHaveBeenCalled();
    expect(mockTombstoneClarificationCancellation).toHaveBeenCalledWith(
      { db: true },
      {
        subjectKey: "ticket:jira:PROJ-1",
        ownerToken: "owner-successor",
        runId: null,
      },
    );
    expect(order).toEqual(["tombstone", "close", "sandboxes", "release"]);
  });

  it("cancels the same reserved owner after it binds before the helper rereads it", async () => {
    const registry = makeRegistry(
      active({ ownerToken: "owner-successor", runId: "run-successor", state: "bound" }),
    );
    mockGetRun.mockReturnValue({ cancel: vi.fn().mockResolvedValue(undefined) });
    mockTombstoneClarificationCancellation.mockResolvedValue({
      matched: true,
      successorOwnerToken: "owner-successor",
    });
    const { cancelRun } = await import("./cancel-run.js");
    expect(
      await cancelRun(
        "PROJ-1",
        { ownerToken: "owner-successor", runId: null },
        registry,
      ),
    ).toBe(true);
    expect(mockGetRun).toHaveBeenCalledWith("run-successor");
    expect(mockTombstoneClarificationCancellation).toHaveBeenCalledWith(
      { db: true },
      {
        subjectKey: "ticket:jira:PROJ-1",
        ownerToken: "owner-successor",
        runId: null,
      },
    );
  });

  it("follows a predecessor handoff that completes before the helper rereads it", async () => {
    const registry = makeRegistry(
      active({ ownerToken: "owner-successor", runId: null, state: "reserved" }),
    );
    mockTombstoneClarificationCancellation.mockResolvedValue({
      matched: true,
      successorOwnerToken: "owner-successor",
    });
    vi.mocked(registry.releaseCancellation).mockResolvedValue(true);

    const { cancelRun } = await import("./cancel-run.js");
    expect(
      await cancelRun(
        "PROJ-1",
        { ownerToken: "owner-a", runId: "run_abc" },
        registry,
      ),
    ).toBe(true);
    expect(registry.releaseCancellation).toHaveBeenCalledWith(
      "ticket:jira:PROJ-1",
      "owner-successor",
      null,
    );
  });

  it("cancels a ticketless PR subject by exact subject and run id", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    mockGetRun.mockReturnValue({ cancel });
    const prEntry = active({
      subjectKey: "pr:github:acme/api#42",
      ticketKey: null,
      kind: "pr_trigger",
      runId: "run_pr",
    });
    const registry = makeRegistry(prEntry);
    const onReleased = vi.fn();

    const { cancelSubjectRun } = await import("./cancel-run.js");
    expect(
      await cancelSubjectRun("pr:github:acme/api#42", "run_pr", registry, onReleased),
    ).toBe(true);
    expect(registry.releaseCancellation).toHaveBeenCalledWith(
      "pr:github:acme/api#42",
      "owner-a",
      "run_pr",
    );
    expect(onReleased).toHaveBeenCalledWith("pr:github:acme/api#42");
  });

  it("confirms the ticket move before releasing ownership", async () => {
    const order: string[] = [];
    mockGetRun.mockReturnValue({ cancel: vi.fn().mockResolvedValue(undefined) });
    const registry = makeRegistry();
    vi.mocked(registry.beginCancellation).mockImplementation(async () => {
      order.push("close");
      return true;
    });
    vi.mocked(registry.listSandboxes).mockImplementation(async () => {
      order.push("sandboxes");
      return [];
    });
    vi.mocked(registry.releaseCancellation).mockImplementation(async () => {
      order.push("release");
      return true;
    });
    const issueTracker = {
      moveTicket: vi.fn().mockImplementation(async () => order.push("move")),
    } as any;

    const { cancelRun } = await import("./cancel-run.js");
    expect(
      await cancelRun(
        "PROJ-1",
        "run_abc",
        registry,
        issueTracker,
        "Backlog",
      ),
    ).toBe(true);
    expect(order).toEqual(["close", "sandboxes", "move", "release"]);
  });

  it("retains the closed owner when the ticket move is unconfirmed", async () => {
    mockGetRun.mockReturnValue({ cancel: vi.fn().mockResolvedValue(undefined) });
    const registry = makeRegistry();
    const issueTracker = {
      moveTicket: vi.fn().mockRejectedValue(new Error("Jira unavailable")),
    } as any;

    const { cancelRun } = await import("./cancel-run.js");
    expect(
      await cancelRun(
        "PROJ-1",
        "run_abc",
        registry,
        issueTracker,
        "Backlog",
      ),
    ).toBe(false);
    expect(registry.beginCancellation).toHaveBeenCalled();
    expect(registry.releaseCancellation).not.toHaveBeenCalled();
  });

  it("does not move a completed ticket when the observed claim disappears before close", async () => {
    const registry = makeRegistry(null);
    const issueTracker = { moveTicket: vi.fn() } as any;

    const { cancelRun } = await import("./cancel-run.js");
    expect(
      await cancelRun(
        "PROJ-1",
        { ownerToken: "owner-a", runId: "run_abc" },
        registry,
        issueTracker,
        "Backlog",
      ),
    ).toBe(false);
    expect(issueTracker.moveTicket).not.toHaveBeenCalled();
    expect(registry.beginCancellation).not.toHaveBeenCalled();
  });

  it("does not move a completed ticket when the claim disappears while closing", async () => {
    const registry = makeRegistry();
    vi.mocked(registry.get)
      .mockResolvedValueOnce(active())
      .mockResolvedValueOnce(null);
    vi.mocked(registry.beginCancellation).mockResolvedValue(false);
    const issueTracker = { moveTicket: vi.fn() } as any;

    const { cancelRun } = await import("./cancel-run.js");
    expect(
      await cancelRun(
        "PROJ-1",
        { ownerToken: "owner-a", runId: "run_abc" },
        registry,
        issueTracker,
        "Backlog",
      ),
    ).toBe(false);
    expect(issueTracker.moveTicket).not.toHaveBeenCalled();
    expect(registry.releaseCancellation).not.toHaveBeenCalled();
  });
});
