import { beforeEach, describe, expect, it, vi } from "vitest";

const steps = vi.hoisted(() => ({
  claimCleanup: vi.fn(),
  deleteSnapshot: vi.fn(),
  markDeleted: vi.fn(),
  markFailed: vi.fn(),
}));

vi.mock("./clarification-snapshot-steps.js", () => ({
  deleteClarificationSnapshotStep: (...args: unknown[]) =>
    steps.deleteSnapshot(...args),
}));

vi.mock("./clarification-checkpoint-steps.js", () => ({
  claimClarificationSnapshotCleanupStep: (...args: unknown[]) =>
    steps.claimCleanup(...args),
  markClarificationSnapshotDeletedStep: (...args: unknown[]) =>
    steps.markDeleted(...args),
  markClarificationSnapshotCleanupFailedStep: (...args: unknown[]) =>
    steps.markFailed(...args),
}));

import { clarificationSnapshotCleanupWorkflow } from "./clarification-snapshot-cleanup.js";

describe("clarificationSnapshotCleanupWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    steps.claimCleanup.mockResolvedValue(true);
    steps.deleteSnapshot.mockResolvedValue(undefined);
    steps.markDeleted.mockResolvedValue(undefined);
    steps.markFailed.mockResolvedValue(undefined);
  });

  it("deletes the snapshot in a serializable step before marking cleanup complete", async () => {
    await clarificationSnapshotCleanupWorkflow({
      clarificationId: "clar-1",
      snapshotId: "snap-1",
    });

    expect(steps.deleteSnapshot).toHaveBeenCalledWith("snap-1");
    expect(steps.claimCleanup).toHaveBeenCalledWith("clar-1");
    expect(steps.markDeleted).toHaveBeenCalledWith("clar-1");
    expect(steps.markFailed).not.toHaveBeenCalled();
  });

  it("lets a duplicate cleanup candidate exit before deleting", async () => {
    steps.claimCleanup.mockResolvedValue(false);

    await clarificationSnapshotCleanupWorkflow({
      clarificationId: "clar-1",
      snapshotId: "snap-1",
    });

    expect(steps.deleteSnapshot).not.toHaveBeenCalled();
    expect(steps.markDeleted).not.toHaveBeenCalled();
    expect(steps.markFailed).not.toHaveBeenCalled();
  });

  it("keeps a failed deletion retryable with the actionable error", async () => {
    steps.deleteSnapshot.mockRejectedValue(new Error("snapshot unavailable"));

    await expect(
      clarificationSnapshotCleanupWorkflow({
        clarificationId: "clar-1",
        snapshotId: "snap-1",
      }),
    ).rejects.toThrow("snapshot unavailable");
    expect(steps.markDeleted).not.toHaveBeenCalled();
    expect(steps.markFailed).toHaveBeenCalledWith(
      "clar-1",
      "snapshot unavailable",
    );
  });
});
