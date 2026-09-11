import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../db/test-db.js";
import {
  getHookClarification,
  prepareHookClarification,
  publishHookClarification,
  recordHookClarificationSnapshot,
} from "../../db/repositories/clarification-hooks.js";

const mocks = vi.hoisted(() => ({
  resumeHook: vi.fn(),
  getHookByToken: vi.fn(),
  deleteSnapshot: vi.fn(),
}));

vi.mock("workflow/api", () => ({
  resumeHook: (...args: unknown[]) => mocks.resumeHook(...args),
  getHookByToken: (...args: unknown[]) => mocks.getHookByToken(...args),
}));
vi.mock("../../engine/steps/clarification-snapshot-steps.js", () => ({
  deleteClarificationSnapshotStep: (...args: unknown[]) => mocks.deleteSnapshot(...args),
}));

const { expireHookClarifications } = await import("./expiry.js");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resumeHook.mockResolvedValue({ runId: "run-1" });
  mocks.getHookByToken.mockRejectedValue(new Error("hook consumed"));
  mocks.deleteSnapshot.mockResolvedValue(undefined);
});

describe("clarification hook expiry", () => {
  it("resumes an expired hook and retires its question", async () => {
    const db = await createTestDb();
    const prepared = await prepareHookClarification(db, {
      ticketKey: "AWT-1",
      subjectKey: "ticket:jira:AWT-1",
      runId: "run-1",
      blockId: "question",
      definitionId: 1,
      definitionVersion: 1,
      questions: ["Continue?"],
    });
    await publishHookClarification(db, prepared.id);
    mocks.resumeHook.mockResolvedValue({ runId: "run-1" });

    const result = await expireHookClarifications(
      db,
      new Date(Date.now() + 8 * 24 * 60 * 60 * 1_000),
    );

    expect(result).toEqual({ expired: 1, retryable: 0, cleanupFailed: 0 });
    expect(mocks.resumeHook).toHaveBeenCalledWith(prepared.hookToken, { expired: true });
    expect((await getHookClarification(db, prepared.id))?.status).toBe("superseded");
  });

  it("leaves the question retryable when the hook still exists", async () => {
    const db = await createTestDb();
    const prepared = await prepareHookClarification(db, {
      ticketKey: null,
      subjectKey: "pr:github:acme/api:1",
      runId: "run-2",
      blockId: "question",
      definitionId: 1,
      definitionVersion: 1,
      questions: ["Continue?"],
    });
    await publishHookClarification(db, prepared.id);
    mocks.resumeHook.mockRejectedValue(new Error("transport failed"));
    mocks.getHookByToken.mockResolvedValue({ runId: "run-2" });

    const result = await expireHookClarifications(
      db,
      new Date(Date.now() + 8 * 24 * 60 * 60 * 1_000),
    );

    expect(result.retryable).toBe(1);
    expect((await getHookClarification(db, prepared.id))?.status).toBe("pending");
  });

  it("retires a snapshotted question and records cleanup in one repository call", async () => {
    const db = await createTestDb();
    const prepared = await prepareHookClarification(db, {
      ticketKey: "AWT-3",
      subjectKey: "ticket:jira:AWT-3",
      runId: "run-3",
      blockId: "question",
      definitionId: 1,
      definitionVersion: 1,
      questions: ["Continue?"],
    });
    await recordHookClarificationSnapshot(db, prepared.id, {
      snapshotId: "snapshot-3",
      sourceSandboxId: "sandbox-3",
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1_000),
    });
    await publishHookClarification(db, prepared.id);

    await expect(
      expireHookClarifications(db, new Date(Date.now() + 8 * 24 * 60 * 60 * 1_000)),
    ).resolves.toEqual({ expired: 1, retryable: 0, cleanupFailed: 0 });

    expect(mocks.deleteSnapshot).toHaveBeenCalledWith("snapshot-3");
    expect(await getHookClarification(db, prepared.id)).toMatchObject({
      status: "superseded",
      cleanupState: "deleted",
    });
  });
});
