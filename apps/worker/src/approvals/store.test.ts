import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { approvalRequests } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import {
  ApprovalStoreError,
  createApprovalRequest,
  decideApproval,
  getApproval,
  listApprovals,
  rejectUndispatchableApproval,
  setDispatchedRunId,
} from "./store.js";

function seed(ticketKey = "AWT-1") {
  return {
    ticketKey,
    definitionId: 1,
    definitionVersion: 4,
    runId: "run-produced",
    plan: { markdown: "# Plan\nDo the thing." },
  };
}

describe("createApprovalRequest", () => {
  it("inserts a pending row with the supplied plan and defaults", async () => {
    const db = await createTestDb();
    const row = await createApprovalRequest(db, seed());
    expect(row.status).toBe("pending");
    expect(row.plan.markdown).toContain("Do the thing.");
    expect(row.assumptions).toBeNull();
    expect(row.requestedBy).toBe("workflow");
    expect(row.id).toMatch(/[0-9a-f-]{36}/);
  });

  it("pins the definition version supplied at creation", async () => {
    const db = await createTestDb();
    const row = await createApprovalRequest(db, { ...seed(), definitionVersion: 7 });
    expect(row.definitionVersion).toBe(7);
    const stored = await getApproval(db, row.id);
    expect(stored?.definitionVersion).toBe(7);
  });

  it("tolerates a null pinned version (legacy row)", async () => {
    const db = await createTestDb();
    const row = await createApprovalRequest(db, { ...seed(), definitionVersion: null });
    expect(row.definitionVersion).toBeNull();
  });

  it("supersedes an existing pending row for the same ticket", async () => {
    const db = await createTestDb();
    const first = await createApprovalRequest(db, seed());
    const second = await createApprovalRequest(db, {
      ...seed(),
      assumptions: ["assumes staging is up"],
    });

    const firstAfter = await getApproval(db, first.id);
    expect(firstAfter?.status).toBe("superseded");
    expect(second.status).toBe("pending");
    expect(second.assumptions).toEqual(["assumes staging is up"]);

    const pending = await listApprovals(db, { status: "pending" });
    expect(pending.map((r) => r.id)).toEqual([second.id]);
  });
});

describe("partial unique index", () => {
  it("rejects a second raw pending row for the same ticket", async () => {
    const db = await createTestDb();
    await createApprovalRequest(db, seed());
    await expect(
      db.insert(approvalRequests).values({
        id: randomUUID(),
        ticketKey: "AWT-1",
        definitionId: 1,
        runId: "run-other",
        plan: { markdown: "x" },
      }),
    ).rejects.toThrow();
  });

  it("allows a new pending row once the prior is decided", async () => {
    const db = await createTestDb();
    const first = await createApprovalRequest(db, seed());
    await decideApproval(db, {
      id: first.id,
      decision: "approved",
      actor: { id: "u1", label: "Alice" },
    });
    const second = await createApprovalRequest(db, seed());
    expect(second.status).toBe("pending");
  });
});

describe("decideApproval CAS", () => {
  it("transitions pending -> approved and records the actor", async () => {
    const db = await createTestDb();
    const row = await createApprovalRequest(db, seed());
    const decided = await decideApproval(db, {
      id: row.id,
      decision: "approved",
      actor: { id: "u1", label: "Alice" },
    });
    expect(decided.status).toBe("approved");
    expect(decided.decidedById).toBe("u1");
    expect(decided.decidedByLabel).toBe("Alice");
    expect(decided.decidedAt).toBeInstanceOf(Date);
  });

  it("throws 409 already_decided on a second decision", async () => {
    const db = await createTestDb();
    const row = await createApprovalRequest(db, seed());
    await decideApproval(db, { id: row.id, decision: "approved", actor: { id: "u1", label: "Alice" } });
    await expect(
      decideApproval(db, { id: row.id, decision: "rejected", actor: { id: "u2", label: "Bob" } }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("throws 409 for an unknown id", async () => {
    const db = await createTestDb();
    await expect(
      decideApproval(db, { id: "missing", decision: "approved", actor: { id: "u1", label: "Alice" } }),
    ).rejects.toBeInstanceOf(ApprovalStoreError);
  });
});

describe("listApprovals ordering", () => {
  it("returns rows newest first", async () => {
    const db = await createTestDb();
    const a = await mkAt(db, "AWT-1", new Date("2026-01-01T00:00:00Z"));
    const b = await mkAt(db, "AWT-2", new Date("2026-01-02T00:00:00Z"));
    const c = await mkAt(db, "AWT-3", new Date("2026-01-03T00:00:00Z"));
    const all = await listApprovals(db, { status: "all" });
    expect(all.map((r) => r.id)).toEqual([c, b, a]);
  });

  it("defaults to pending only", async () => {
    const db = await createTestDb();
    const pendingRow = await createApprovalRequest(db, seed("AWT-1"));
    const decidedRow = await createApprovalRequest(db, seed("AWT-2"));
    await decideApproval(db, { id: decidedRow.id, decision: "rejected", actor: { id: "u1", label: "Alice" } });
    const list = await listApprovals(db);
    expect(list.map((r) => r.id)).toEqual([pendingRow.id]);
  });
});

describe("setDispatchedRunId", () => {
  it("records the dispatched run", async () => {
    const db = await createTestDb();
    const row = await createApprovalRequest(db, seed());
    await decideApproval(db, {
      id: row.id,
      decision: "approved",
      actor: { id: "u1", label: "Alice" },
    });
    await setDispatchedRunId(db, row.id, "run-dispatched");
    const after = await getApproval(db, row.id);
    expect(after?.dispatchedRunId).toBe("run-dispatched");
  });

  it("is idempotent for the same run and refuses to replace a recorded dispatch", async () => {
    const db = await createTestDb();
    const row = await createApprovalRequest(db, seed());
    await decideApproval(db, {
      id: row.id,
      decision: "approved",
      actor: { id: "u1", label: "Alice" },
    });
    await setDispatchedRunId(db, row.id, "run-first");
    await expect(setDispatchedRunId(db, row.id, "run-first")).resolves.toBeUndefined();
    await expect(setDispatchedRunId(db, row.id, "run-second")).rejects.toMatchObject({
      statusCode: 409,
      message: "dispatch_already_recorded",
    });
    expect((await getApproval(db, row.id))?.dispatchedRunId).toBe("run-first");
  });

  it("refuses to attach a run after terminal rejection wins the CAS", async () => {
    const db = await createTestDb();
    const row = await createApprovalRequest(db, seed());
    await decideApproval(db, {
      id: row.id,
      decision: "approved",
      actor: { id: "u1", label: "Alice" },
    });
    await rejectUndispatchableApproval(db, row.id);

    await expect(setDispatchedRunId(db, row.id, "run-late")).rejects.toMatchObject({
      statusCode: 409,
      message: "dispatch_already_recorded",
    });
    expect(await getApproval(db, row.id)).toMatchObject({
      status: "rejected",
      dispatchedRunId: null,
    });
  });
});

async function mkAt(db: Db, ticketKey: string, requestedAt: Date): Promise<string> {
  const id = randomUUID();
  await db.insert(approvalRequests).values({
    id,
    ticketKey,
    definitionId: 1,
    runId: "run-produced",
    plan: { markdown: "x" },
    requestedAt,
  });
  return id;
}
