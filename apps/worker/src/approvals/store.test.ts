import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { approvalRequests } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import {
  ApprovalStoreError,
  createApprovalRequest,
  decideApproval,
  getApproval,
  hasDispatchBlockingApprovalForTicket,
  listApprovals,
  listDispatchBlockingApprovals,
  rejectUndispatchableApproval,
  retireApprovalCancellation,
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

  it("keeps the previous pending approval when replacement insertion fails", async () => {
    const db = await createTestDb();
    const previous = await createApprovalRequest(db, seed("AWT-ROLLBACK"));
    await db.execute(sql`
      create function fail_selected_approval_insert() returns trigger as $$
      begin
        if new.plan->>'markdown' = 'FAIL_INSERT' then
          raise exception 'forced approval insert failure';
        end if;
        return new;
      end;
      $$ language plpgsql
    `);
    await db.execute(sql`
      create trigger fail_selected_approval_insert_trigger
      before insert on approval_requests
      for each row execute function fail_selected_approval_insert()
    `);

    await expect(
      createApprovalRequest(db, {
        ...seed("AWT-ROLLBACK"),
        plan: { markdown: "FAIL_INSERT" },
      }),
    ).rejects.toThrow();

    await expect(getApproval(db, previous.id)).resolves.toMatchObject({
      status: "pending",
      ticketKey: "AWT-ROLLBACK",
    });
    await expect(listApprovals(db)).resolves.toEqual([
      expect.objectContaining({ id: previous.id, status: "pending" }),
    ]);
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

describe("listDispatchBlockingApprovals", () => {
  it("protects pending decisions and approved plans until a pinned successor acknowledges dispatch", async () => {
    const db = await createTestDb();
    const recoverable = await createApprovalRequest(db, seed("AWT-RECOVER"));
    const dispatched = await createApprovalRequest(db, seed("AWT-DISPATCHED"));
    const pending = await createApprovalRequest(db, seed("AWT-PENDING"));
    const rejected = await createApprovalRequest(db, seed("AWT-REJECTED"));
    await decideApproval(db, {
      id: recoverable.id,
      decision: "approved",
      actor: { id: "u1", label: "Alice" },
    });
    await decideApproval(db, {
      id: dispatched.id,
      decision: "approved",
      actor: { id: "u1", label: "Alice" },
    });
    await setDispatchedRunId(db, dispatched.id, "run-successor");
    await decideApproval(db, {
      id: rejected.id,
      decision: "rejected",
      actor: { id: "u1", label: "Alice" },
    });

    await expect(listDispatchBlockingApprovals(db)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: recoverable.id,
          ticketKey: "AWT-RECOVER",
          status: "approved",
          dispatchedRunId: null,
        }),
        expect.objectContaining({
          id: pending.id,
          ticketKey: "AWT-PENDING",
          status: "pending",
          dispatchedRunId: null,
        }),
      ]),
    );
    expect(await listDispatchBlockingApprovals(db)).toHaveLength(2);
  });

  it("checks one ticket without treating another ticket's approval as a blocker", async () => {
    const db = await createTestDb();
    await createApprovalRequest(db, seed("AWT-BLOCKED"));

    await expect(
      hasDispatchBlockingApprovalForTicket(db, "AWT-BLOCKED"),
    ).resolves.toBe(true);
    await expect(
      hasDispatchBlockingApprovalForTicket(db, "AWT-OTHER"),
    ).resolves.toBe(false);
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

describe("rejectUndispatchableApproval", () => {
  it("cannot revoke an approved human decision", async () => {
    const db = await createTestDb();
    const row = await createApprovalRequest(db, seed());
    await decideApproval(db, {
      id: row.id,
      decision: "approved",
      actor: { id: "u1", label: "Alice" },
    });

    await expect(rejectUndispatchableApproval(db, row.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(getApproval(db, row.id)).resolves.toMatchObject({
      status: "approved",
      decidedById: "u1",
    });
  });
});

describe("retireApprovalCancellation", () => {
  it("lets cancellation retire the pending request before a human decision wins", async () => {
    const db = await createTestDb();
    const pending = await createApprovalRequest(db, seed("AWT-PENDING"));

    await expect(
      retireApprovalCancellation(db, {
        ticketKey: "AWT-PENDING",
        runId: "run-produced",
      }),
    ).resolves.toBe(1);
    await expect(
      decideApproval(db, {
        id: pending.id,
        decision: "approved",
        actor: { id: "u1", label: "Alice" },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(await getApproval(db, pending.id)).toMatchObject({ status: "superseded" });
  });

  it("cannot revoke an approval after the human decision wins the race", async () => {
    const db = await createTestDb();
    const approved = await createApprovalRequest(db, seed("AWT-APPROVED"));
    await decideApproval(db, {
      id: approved.id,
      decision: "approved",
      actor: { id: "u1", label: "Alice" },
    });

    await expect(
      retireApprovalCancellation(db, {
        ticketKey: "AWT-APPROVED",
        runId: "run-produced",
      }),
    ).resolves.toBe(0);

    expect(await getApproval(db, approved.id)).toMatchObject({
      status: "approved",
      decidedById: "u1",
      dispatchedRunId: null,
    });
    await expect(listDispatchBlockingApprovals(db)).resolves.toEqual([
      expect.objectContaining({ id: approved.id, status: "approved" }),
    ]);
  });

  it("does not retire another run or an approval already attached to a successor", async () => {
    const db = await createTestDb();
    const other = await createApprovalRequest(db, {
      ...seed("AWT-OTHER"),
      runId: "run-other",
    });
    const dispatched = await createApprovalRequest(db, seed("AWT-DISPATCHED"));
    await decideApproval(db, {
      id: dispatched.id,
      decision: "approved",
      actor: { id: "u1", label: "Alice" },
    });
    await setDispatchedRunId(db, dispatched.id, "run-successor");

    await expect(
      retireApprovalCancellation(db, {
        ticketKey: "AWT-OTHER",
        runId: "run-produced",
      }),
    ).resolves.toBe(0);
    await expect(
      retireApprovalCancellation(db, {
        ticketKey: "AWT-DISPATCHED",
        runId: "run-produced",
      }),
    ).resolves.toBe(0);

    expect(await getApproval(db, other.id)).toMatchObject({ status: "pending" });
    expect(await getApproval(db, dispatched.id)).toMatchObject({
      status: "approved",
      dispatchedRunId: "run-successor",
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
