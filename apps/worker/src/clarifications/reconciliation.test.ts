import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listUndispatched: vi.fn(),
  dispatchAnswered: vi.fn(),
  resolveAwaitingRun: vi.fn(),
  listCleanup: vi.fn(),
  claimCleanup: vi.fn(),
  markCleanupFailed: vi.fn(),
  start: vi.fn(),
}));

vi.mock("./store.js", () => ({
  listUndispatchedAnsweredClarifications: (...args: unknown[]) =>
    mocks.listUndispatched(...args),
  listClarificationSnapshotCleanup: (...args: unknown[]) => mocks.listCleanup(...args),
  claimClarificationSnapshotCleanup: (...args: unknown[]) => mocks.claimCleanup(...args),
  markClarificationSnapshotCleanupFailed: (...args: unknown[]) =>
    mocks.markCleanupFailed(...args),
}));

vi.mock("./dispatch.js", () => ({
  dispatchClarificationAnswered: (...args: unknown[]) => mocks.dispatchAnswered(...args),
}));

vi.mock("../lib/telemetry/run-telemetry.js", () => ({
  resolveAwaitingRun: (...args: unknown[]) => mocks.resolveAwaitingRun(...args),
}));

vi.mock("workflow/api", () => ({
  start: (...args: unknown[]) => mocks.start(...args),
}));

vi.mock("../workflows/clarification-snapshot-cleanup.js", () => ({
  clarificationSnapshotCleanupWorkflow: vi.fn(),
}));

import {
  recoverUndispatchedClarificationSuccessors,
  startQueuedClarificationSnapshotCleanups,
} from "./reconciliation.js";

const db = {} as never;
const runRegistry = {} as never;
const issueTracker = {} as never;

describe("clarification reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listUndispatched.mockResolvedValue([]);
    mocks.listCleanup.mockResolvedValue([]);
    mocks.claimCleanup.mockResolvedValue(true);
    mocks.markCleanupFailed.mockResolvedValue(undefined);
    mocks.resolveAwaitingRun.mockResolvedValue(true);
    mocks.start.mockResolvedValue({ runId: "cleanup-run" });
  });

  it("retries answered checkpoints and records the one winning successor run", async () => {
    const checkpoint = {
      id: "clar-1",
      runId: "run-parked",
      answer: "keep ours",
      answeredById: "user-1",
      answeredByLabel: "Alice",
    };
    mocks.listUndispatched.mockResolvedValue([checkpoint]);
    mocks.dispatchAnswered.mockResolvedValue({ status: "started", runId: "run-next" });

    expect(
      await recoverUndispatchedClarificationSuccessors({
        db,
        runRegistry,
        issueTracker,
        maxConcurrentAgents: 3,
      }),
    ).toBe(1);
    expect(mocks.dispatchAnswered).toHaveBeenCalledWith(
      expect.objectContaining({
        clarification: checkpoint,
        answer: "keep ours",
        actor: { id: "user-1", label: "Alice" },
        isRetry: true,
      }),
    );
    expect(mocks.resolveAwaitingRun).not.toHaveBeenCalled();
  });

  it("starts a durable workflow that owns cleanup claiming internally", async () => {
    const candidate = { clarificationId: "clar-1", snapshotId: "snap-1" };
    mocks.listCleanup.mockResolvedValue([candidate]);

    expect(await startQueuedClarificationSnapshotCleanups({ db })).toBe(1);
    expect(mocks.claimCleanup).not.toHaveBeenCalled();
    expect(mocks.start).toHaveBeenCalledWith(expect.any(Function), [candidate]);
  });

  it("returns a failed start to the retry queue", async () => {
    const candidate = { clarificationId: "clar-1", snapshotId: "snap-1" };
    mocks.listCleanup.mockResolvedValue([candidate]);
    mocks.start.mockRejectedValue(new Error("start failed"));

    expect(await startQueuedClarificationSnapshotCleanups({ db })).toBe(0);
    expect(mocks.markCleanupFailed).toHaveBeenCalledWith(db, "clar-1", "start failed");
  });
});
