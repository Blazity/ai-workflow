import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "../db/test-db.js";
import {
  getHookClarification,
  prepareHookClarification,
  publishHookClarification,
} from "./hook-store.js";

const mocks = vi.hoisted(() => ({
  resumeHook: vi.fn(),
  getHookByToken: vi.fn(),
  deleteSnapshot: vi.fn(),
}));

vi.mock("workflow/api", () => ({
  resumeHook: (...args: unknown[]) => mocks.resumeHook(...args),
  getHookByToken: (...args: unknown[]) => mocks.getHookByToken(...args),
}));
vi.mock("../workflows/clarification-snapshot-steps.js", () => ({
  deleteClarificationSnapshotStep: (...args: unknown[]) => mocks.deleteSnapshot(...args),
}));

const { expireHookClarifications } = await import("./expiry.js");

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
});
