import { describe, expect, it } from "vitest";
import { createTestDb } from "../db/test-db.js";
import {
  answerHookClarification,
  getHookClarification,
  prepareHookClarification,
  publishHookClarification,
  recordHookClarificationSnapshot,
} from "./hook-store.js";

const input = {
  ticketKey: "AWT-1",
  subjectKey: "ticket:jira:AWT-1",
  runId: "run-1",
  blockId: "question",
  definitionId: 4,
  definitionVersion: 7,
  questions: ["Which repository?"],
};

describe("clarification hook store", () => {
  it("publishes only after the hook row and optional snapshot are durable", async () => {
    const db = await createTestDb();
    const prepared = await prepareHookClarification(db, input);
    expect(prepared.status).toBe("preparing");
    expect(prepared.hookToken).toBe(`clarification:${prepared.id}`);

    await recordHookClarificationSnapshot(db, prepared.id, {
      snapshotId: "snapshot-1",
      sourceSandboxId: "sandbox-1",
      expiresAt: new Date("2026-07-27T00:00:00.000Z"),
    });
    const published = await publishHookClarification(db, prepared.id);

    expect(published).toMatchObject({
      status: "pending",
      snapshotId: "snapshot-1",
      cleanupState: "retained",
    });
  });

  it("allows exactly one answer CAS", async () => {
    const db = await createTestDb();
    const prepared = await prepareHookClarification(db, input);
    await publishHookClarification(db, prepared.id);

    const [first, second] = await Promise.all([
      answerHookClarification(db, prepared.id, "API", { id: "u1", label: "One" }),
      answerHookClarification(db, prepared.id, "Dashboard", { id: "u2", label: "Two" }),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect((await getHookClarification(db, prepared.id))?.status).toBe("answered");
  });
});
