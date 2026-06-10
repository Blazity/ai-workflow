import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { GateStore } from "./gate-store.js";
import { createTestDb } from "../db/test-db.js";
import type { Db } from "../db/client.js";

let db: Db;
let store: GateStore;

beforeEach(async () => {
  db = await createTestDb();
  store = new GateStore(db);
});

/** Backdate a lock so it reads as TTL-expired. */
async function expireLock(repo: string, pr: number) {
  await db.execute(
    sql`UPDATE gate_locks SET expires_at = now() - interval '1 second' WHERE repo = ${repo} AND pr = ${pr}`,
  );
}

describe("locks", () => {
  it("acquireLock returns a token when free", async () => {
    const token = await store.acquireLock("o/r", 1);
    expect(token).toBeTruthy();
  });

  it("acquireLock returns null while held", async () => {
    await store.acquireLock("o/r", 1);
    expect(await store.acquireLock("o/r", 1)).toBeNull();
  });

  it("acquireLock steals an expired lock (TTL crash-safety)", async () => {
    await store.acquireLock("o/r", 1);
    await expireLock("o/r", 1);
    expect(await store.acquireLock("o/r", 1)).toBeTruthy();
  });

  it("locks are independent per repo+pr", async () => {
    await store.acquireLock("o/r", 1);
    expect(await store.acquireLock("o/r", 2)).toBeTruthy();
    expect(await store.acquireLock("o/other", 1)).toBeTruthy();
  });

  it("releaseLock with the owning token frees the lock", async () => {
    const token = (await store.acquireLock("o/r", 1))!;
    await store.releaseLock("o/r", 1, token);
    expect(await store.acquireLock("o/r", 1)).toBeTruthy();
  });

  it("releaseLock with a stale token is a no-op (compare-and-delete)", async () => {
    await store.acquireLock("o/r", 1);
    await expireLock("o/r", 1);
    const newToken = (await store.acquireLock("o/r", 1))!;
    await store.releaseLock("o/r", 1, "stale-token");
    // still held by newToken
    expect(await store.acquireLock("o/r", 1)).toBeNull();
    await store.releaseLock("o/r", 1, newToken);
    expect(await store.acquireLock("o/r", 1)).toBeTruthy();
  });
});

describe("claimRun (dedupe)", () => {
  it("returns null when we win the claim", async () => {
    expect(await store.claimRun("o/r", 1, "sha1", "run_a")).toBeNull();
  });

  it("returns the existing runId when already claimed", async () => {
    await store.claimRun("o/r", 1, "sha1", "run_a");
    expect(await store.claimRun("o/r", 1, "sha1", "run_b")).toBe("run_a");
  });

  it("different SHA is a fresh claim", async () => {
    await store.claimRun("o/r", 1, "sha1", "run_a");
    expect(await store.claimRun("o/r", 1, "sha2", "run_b")).toBeNull();
  });

  it("an expired claim behaves as absent (re-claimable)", async () => {
    await store.claimRun("o/r", 1, "sha1", "run_a");
    await db.execute(
      sql`UPDATE gate_dedupe SET expires_at = now() - interval '1 second'`,
    );
    expect(await store.claimRun("o/r", 1, "sha1", "run_b")).toBeNull();
    expect(await store.getDedupe("o/r", 1, "sha1")).toBe("run_b");
  });

  it("getDedupe returns null for unknown or expired claims", async () => {
    expect(await store.getDedupe("o/r", 1, "nope")).toBeNull();
    await store.claimRun("o/r", 1, "sha1", "run_a");
    await db.execute(
      sql`UPDATE gate_dedupe SET expires_at = now() - interval '1 second'`,
    );
    expect(await store.getDedupe("o/r", 1, "sha1")).toBeNull();
  });
});

describe("current pointer", () => {
  const current = { runId: "run_a", headSha: "sha1", checkRunIds: [] as number[] };

  it("setCurrent/getCurrent round-trips", async () => {
    await store.setCurrent("o/r", 1, current);
    expect(await store.getCurrent("o/r", 1)).toEqual(current);
  });

  it("getCurrent returns null when absent or expired", async () => {
    expect(await store.getCurrent("o/r", 1)).toBeNull();
    await store.setCurrent("o/r", 1, current);
    await db.execute(
      sql`UPDATE gate_current SET expires_at = now() - interval '1 second'`,
    );
    expect(await store.getCurrent("o/r", 1)).toBeNull();
  });

  it("setCurrent overwrites on force-push (same PR, new SHA)", async () => {
    await store.setCurrent("o/r", 1, current);
    await store.setCurrent("o/r", 1, { runId: "run_b", headSha: "sha2", checkRunIds: [7] });
    expect(await store.getCurrent("o/r", 1)).toEqual({
      runId: "run_b",
      headSha: "sha2",
      checkRunIds: [7],
    });
  });

  it("appendCheckRunIdsForSha appends when SHA matches, accumulating", async () => {
    await store.setCurrent("o/r", 1, current);
    // GitHub check-run IDs exceed int4 — proves bigint[].
    expect(await store.appendCheckRunIdsForSha("o/r", 1, "sha1", [30000000001])).toBe(true);
    expect(await store.appendCheckRunIdsForSha("o/r", 1, "sha1", [30000000002, 5])).toBe(true);
    expect((await store.getCurrent("o/r", 1))!.checkRunIds).toEqual([
      30000000001, 30000000002, 5,
    ]);
  });

  it("appendCheckRunIdsForSha returns false on SHA mismatch or missing pointer", async () => {
    expect(await store.appendCheckRunIdsForSha("o/r", 1, "sha1", [1])).toBe(false);
    await store.setCurrent("o/r", 1, current);
    expect(await store.appendCheckRunIdsForSha("o/r", 1, "superseded", [1])).toBe(false);
    expect((await store.getCurrent("o/r", 1))!.checkRunIds).toEqual([]);
  });

  it("appendCheckRunIdsForSha with empty ids is a no-op true", async () => {
    expect(await store.appendCheckRunIdsForSha("o/r", 1, "sha1", [])).toBe(true);
  });

  it("appendCheckRunIdsForSha returns false on an expired pointer", async () => {
    await store.setCurrent("o/r", 1, current);
    await db.execute(
      sql`UPDATE gate_current SET expires_at = now() - interval '1 second'`,
    );
    expect(await store.appendCheckRunIdsForSha("o/r", 1, "sha1", [1])).toBe(false);
  });

  it("updateRunIdIfHeadSha returns false on an expired pointer", async () => {
    await store.setCurrent("o/r", 1, current);
    await db.execute(
      sql`UPDATE gate_current SET expires_at = now() - interval '1 second'`,
    );
    expect(await store.updateRunIdIfHeadSha("o/r", 1, "sha1", "run_x")).toBe(false);
  });

  it("updateRunIdIfHeadSha updates only on SHA match, preserving checkRunIds", async () => {
    await store.setCurrent("o/r", 1, current);
    await store.appendCheckRunIdsForSha("o/r", 1, "sha1", [42]);
    expect(await store.updateRunIdIfHeadSha("o/r", 1, "sha1", "run_real")).toBe(true);
    expect(await store.getCurrent("o/r", 1)).toEqual({
      runId: "run_real",
      headSha: "sha1",
      checkRunIds: [42],
    });
    expect(await store.updateRunIdIfHeadSha("o/r", 1, "superseded", "run_x")).toBe(false);
  });

  it("clearCurrent removes the pointer", async () => {
    await store.setCurrent("o/r", 1, current);
    await store.clearCurrent("o/r", 1);
    expect(await store.getCurrent("o/r", 1)).toBeNull();
  });
});

describe("purgeExpired", () => {
  it("deletes only expired rows across all three gate tables", async () => {
    await store.acquireLock("o/r", 1);
    await store.claimRun("o/r", 1, "sha1", "run_a");
    await store.setCurrent("o/r", 1, { runId: "run_a", headSha: "sha1", checkRunIds: [] });
    await store.claimRun("o/r", 2, "sha9", "run_keep");
    // Expire everything for PR 1 only.
    await db.execute(sql`UPDATE gate_locks SET expires_at = now() - interval '1 second' WHERE pr = 1`);
    await db.execute(sql`UPDATE gate_dedupe SET expires_at = now() - interval '1 second' WHERE pr = 1`);
    await db.execute(sql`UPDATE gate_current SET expires_at = now() - interval '1 second' WHERE pr = 1`);

    await store.purgeExpired();

    const locks = await db.execute(sql`SELECT count(*)::int AS n FROM gate_locks`);
    const dedupe = await db.execute(sql`SELECT count(*)::int AS n FROM gate_dedupe`);
    const cur = await db.execute(sql`SELECT count(*)::int AS n FROM gate_current`);
    expect(locks.rows[0].n).toBe(0);
    expect(dedupe.rows[0].n).toBe(1); // run_keep survives
    expect(cur.rows[0].n).toBe(0);
  });
});
