import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../client.js";
import { createTestDb } from "../test-db.js";
import {
  changeMemoryEntryState,
  getMemoryEntryState,
  listMemoryEntryStates,
  recordMemoryEntryState,
  type MemoryEntryStateValues,
} from "./memory-entry-state.js";
import { forgetMemoryText, listRunMemoryEvents, type MemoryEventRecord } from "./memory-events.js";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const subject = "repo:github:acme/api";
const alias = { subject, kind: "facts" as const, textHash: sha("use pnpm") };

const learned: MemoryEntryStateValues = {
  storeIds: { builtin: "b-1" },
  topic: "commands",
  area: "apps/api",
  areaStatus: "resolved",
  areaCandidates: [],
  module: "apps/api",
  anchors: ["apps/api/package.json"],
  trust: "learned",
  pinned: false,
  status: "active",
  statusReason: null,
  openDisputes: [],
  relearnedUnseen: 0,
  originRunId: "run-1",
  originTicket: "AWT-1",
  lastAdmittedAt: null,
};

function event(overrides: Partial<MemoryEventRecord> = {}): MemoryEventRecord {
  return { event: "classified", runId: "run-1", actor: "run", source: "distill", store: "builtin", ...overrides };
}

async function runEvents(runId = "run-1") {
  return (await listRunMemoryEvents(db, runId)).events;
}

describe("recordMemoryEntryState", () => {
  it("creates the entry under a new stable key and writes its events carrying that key", async () => {
    const written = await recordMemoryEntryState(db, {
      alias,
      create: learned,
      events: [event({ event: "added", text: "Use pnpm", textHash: alias.textHash }), event()],
    });

    expect(written.applied).toBe(true);
    if (!written.applied) return;
    expect(written.version).toBe(1);
    expect(written.eventIds).toHaveLength(2);

    const stored = await getMemoryEntryState(db, { entryKey: written.entryKey });
    expect(stored).toMatchObject({ ...alias, ...learned, version: 1 });
    const events = await runEvents();
    expect(events.map((row) => [row.event, row.entryKey, row.subject, row.kind, row.textHash])).toEqual([
      ["added", written.entryKey, subject, "facts", alias.textHash],
      ["classified", written.entryKey, subject, "facts", alias.textHash],
    ]);
  });

  it("changes only the fields named on an entry that already has the alias, and moves the version", async () => {
    const created = await recordMemoryEntryState(db, { alias, create: learned, events: [event()] });
    const changed = await recordMemoryEntryState(db, {
      alias,
      create: { ...learned, topic: "other" },
      change: { area: "apps/api/src", anchors: ["apps/api/src/index.ts"] },
      events: [event({ event: "reclassified" })],
    });

    expect(changed).toMatchObject({ applied: true, version: 2 });
    if (!created.applied || !changed.applied) return;
    expect(changed.entryKey).toBe(created.entryKey);
    expect(await getMemoryEntryState(db, { alias })).toMatchObject({
      topic: "commands",
      area: "apps/api/src",
      anchors: ["apps/api/src/index.ts"],
      trust: "learned",
    });
  });

  it("writes neither the state nor any event when one event is refused", async () => {
    await expect(
      recordMemoryEntryState(db, {
        alias,
        create: learned,
        // A negative size: the table refuses the row.
        events: [event(), event({ event: "added", bytes: -1 })],
      }),
    ).rejects.toThrow();

    expect(await getMemoryEntryState(db, { alias })).toBeNull();
    expect(await runEvents()).toEqual([]);
  });

  it("writes no event when the state is refused", async () => {
    await expect(
      recordMemoryEntryState(db, {
        alias,
        create: { ...learned, areaCandidates: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] },
        events: [event()],
      }),
    ).rejects.toThrow();

    expect(await getMemoryEntryState(db, { alias })).toBeNull();
    expect(await runEvents()).toEqual([]);
  });

  it("refuses to create over an existing entry when the caller read none (expected version 0)", async () => {
    await recordMemoryEntryState(db, { alias, create: learned, events: [event()] });
    const second = await recordMemoryEntryState(db, {
      alias,
      create: { ...learned, trust: "derived" },
      expectedVersion: 0,
      events: [event({ runId: "run-2" })],
    });

    expect(second).toEqual({ applied: false, why: "version_mismatch", storedVersion: 1 });
    expect(await getMemoryEntryState(db, { alias })).toMatchObject({ trust: "learned", version: 1 });
    expect(await runEvents("run-2")).toEqual([]);
  });

  it("does nothing at all for a second write with the same (run id, dedupe key)", async () => {
    await recordMemoryEntryState(db, {
      alias,
      create: learned,
      events: [event({ dedupeKey: "classify:1" })],
    });
    const again = await recordMemoryEntryState(db, {
      alias,
      create: learned,
      change: { topic: "testing" },
      events: [event({ dedupeKey: "classify:1" })],
    });

    expect(again).toEqual({ applied: false, why: "duplicate", storedVersion: 1 });
    expect(await getMemoryEntryState(db, { alias })).toMatchObject({ topic: "commands", version: 1 });
    expect(await runEvents()).toHaveLength(1);
  });
});

describe("store ids", () => {
  it("keeps the stored id when a second id is offered for the same store, says so, and fills a store it lacks", async () => {
    await recordMemoryEntryState(db, { alias, create: { ...learned, storeIds: { mem0: "m-a1" } }, events: [event()] });

    // A second run learned the same entry in another spelling; Mem0 gave it another id.
    const second = await recordMemoryEntryState(db, {
      alias,
      create: { ...learned, storeIds: { mem0: "m-b1", builtin: "b-1" } },
      events: [event({ runId: "run-2", event: "added" })],
    });

    expect(second).toMatchObject({
      applied: true,
      storeIdConflicts: [{ store: "mem0", kept: "m-a1", offered: "m-b1" }],
    });
    expect((await getMemoryEntryState(db, { alias }))!.storeIds).toEqual({ mem0: "m-a1", builtin: "b-1" });
  });
});

describe("a write that raced another to its dedupe key", () => {
  /** The error Postgres answers when a concurrent write recorded the same
   *  (run, dedupe key) between this statement's check and its insert: taken
   *  from a real unique violation on the index, so its shape is the driver's. */
  async function dedupeRaceError(): Promise<unknown> {
    const other = await createTestDb();
    try {
      await other.execute(sql`INSERT INTO memory_events (event, run_id, actor, dedupe_key)
        VALUES ('added', 'run-1', 'run', 'k'), ('added', 'run-1', 'run', 'k')`);
    } catch (error) {
      return error;
    }
    throw new Error("setup: no unique violation");
  }

  function failingWith(error: unknown): Db {
    return new Proxy(db, {
      get(object, property, receiver) {
        if (property === "execute") return () => Promise.reject(error);
        const value = Reflect.get(object, property, receiver) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(object) : value;
      },
    });
  }

  it("is reported as a duplicate, not a failure, by every state write and a forget", async () => {
    const raced = failingWith(await dedupeRaceError());

    await expect(recordMemoryEntryState(raced, { alias, create: learned, events: [event({ dedupeKey: "k" })] })).resolves.toEqual({
      applied: false,
      why: "duplicate",
      storedVersion: null,
    });
    await expect(
      changeMemoryEntryState(raced, { target: { alias }, change: { pinned: true }, events: [event({ event: "pinned", dedupeKey: "k" })] }),
    ).resolves.toEqual({ applied: false, why: "duplicate", storedVersion: null });
    await expect(
      forgetMemoryText(raced, {
        textHash: alias.textHash,
        subject,
        events: [event({ event: "removed", reason: "forgotten", dedupeKey: "k" })],
      }),
    ).resolves.toEqual({ applied: false, why: "duplicate" });
  });

  it("still fails on any other refusal", async () => {
    const refused = failingWith(Object.assign(new Error("check"), { cause: { code: "23514", constraint: "memory_events_text_hashed_check" } }));

    await expect(recordMemoryEntryState(refused, { alias, create: learned, events: [event()] })).rejects.toThrow("check");
  });

  it("refuses a write whose own events share a dedupe key, which would otherwise read as a race", async () => {
    await expect(
      recordMemoryEntryState(db, {
        alias,
        create: learned,
        events: [event({ dedupeKey: "k" }), event({ event: "added", dedupeKey: "k" })],
      }),
    ).rejects.toThrow("share a dedupe key");
  });
});

describe("changeMemoryEntryState", () => {
  async function created(values: MemoryEntryStateValues = learned) {
    const written = await recordMemoryEntryState(db, { alias, create: values, events: [event()] });
    if (!written.applied) throw new Error("setup: entry not created");
    return written.entryKey;
  }

  it("moves the alias to the new text on an update, keeping the key, the trust and the pin", async () => {
    const entryKey = await created({ ...learned, trust: "human", pinned: true });
    const newHash = sha("use pnpm 9");

    const moved = await changeMemoryEntryState(db, {
      target: { alias },
      moveTo: newHash,
      events: [
        event({
          event: "updated",
          actor: "admin:user-7",
          text: "Use pnpm 9",
          textHash: newHash,
          previousText: "Use pnpm",
          previousTextHash: alias.textHash,
        }),
      ],
    });

    expect(moved).toMatchObject({ applied: true, entryKey, version: 2 });
    expect(await getMemoryEntryState(db, { alias })).toBeNull();
    expect(await getMemoryEntryState(db, { alias: { ...alias, textHash: newHash } })).toMatchObject({
      entryKey,
      trust: "human",
      pinned: true,
    });
    const [, updated] = await runEvents();
    expect(updated).toMatchObject({ event: "updated", entryKey, textHash: newHash, previousTextHash: alias.textHash });
  });

  it("moves the alias and the store id when the store replaces the entry itself, keeping key, trust and pin", async () => {
    const entryKey = await created({ ...learned, storeIds: { mem0: "m-1" }, trust: "human", pinned: true });
    const newHash = sha("use pnpm workspaces");

    const moved = await changeMemoryEntryState(db, {
      target: { entryKey },
      moveTo: newHash,
      change: { storeIds: { mem0: "m-2" } },
      events: [event({ event: "superseded_by_store", actor: "system", store: "mem0", entryId: "m-2" })],
    });

    expect(moved).toMatchObject({ applied: true, entryKey });
    expect(await getMemoryEntryState(db, { entryKey })).toMatchObject({
      textHash: newHash,
      storeIds: { mem0: "m-2" },
      trust: "human",
      pinned: true,
    });
  });

  it("keeps the other stores' ids when one store's id changes, and drops an id set to null", async () => {
    const entryKey = await created({ ...learned, storeIds: { builtin: "b-1", mem0: "m-1" } });

    await changeMemoryEntryState(db, {
      target: { entryKey },
      change: { storeIds: { builtin: null, mem0: "m-2" } },
      events: [event({ event: "removed", reason: "cap", store: "builtin" })],
    });

    expect((await getMemoryEntryState(db, { entryKey }))?.storeIds).toEqual({ mem0: "m-2" });
  });

  it("refuses to move onto a text another entry already answers to, and writes no event", async () => {
    await created();
    const other = { ...alias, textHash: sha("use npm") };
    await recordMemoryEntryState(db, { alias: other, create: learned, events: [event()] });

    const moved = await changeMemoryEntryState(db, {
      target: { alias },
      moveTo: other.textHash,
      events: [event({ event: "updated", runId: "run-2" })],
    });

    expect(moved).toEqual({ applied: false, why: "alias_taken", storedVersion: 1 });
    expect(await getMemoryEntryState(db, { alias })).not.toBeNull();
    expect(await runEvents("run-2")).toEqual([]);
  });

  it("refuses a change made against a version that has moved since, and writes no event", async () => {
    const entryKey = await created();
    await changeMemoryEntryState(db, {
      target: { entryKey },
      change: { trust: "human" },
      events: [event({ event: "trust_changed", actor: "admin:user-7" })],
    });

    const stale = await changeMemoryEntryState(db, {
      target: { entryKey },
      expectedVersion: 1,
      change: { status: "disputed" },
      events: [event({ event: "disputed", runId: "run-2" })],
    });

    expect(stale).toEqual({ applied: false, why: "version_mismatch", storedVersion: 2 });
    expect(await getMemoryEntryState(db, { entryKey })).toMatchObject({ trust: "human", status: "active" });
    expect(await runEvents("run-2")).toEqual([]);
  });

  it("answers not found for an entry that has no state, and writes no event", async () => {
    const missing = await changeMemoryEntryState(db, {
      target: { entryKey: "8a6b4d0e-51c9-4b39-9d5b-7c1f3c2a9e10" },
      change: { pinned: true },
      events: [event({ event: "pinned" })],
    });

    expect(missing).toEqual({ applied: false, why: "not_found", storedVersion: null });
    expect(await runEvents()).toEqual([]);
  });

  it("keeps both of two disputes written at once, with both events, and counts both relearnings", async () => {
    const entryKey = await created();
    const dispute = (runId: string) => ({ runId, ticketKey: null, outcome: "failed", evidence: "claimed", reason: "no" });

    const written = await Promise.all(
      ["run-a", "run-b"].map((runId) =>
        changeMemoryEntryState(db, {
          target: { entryKey },
          change: { status: "disputed", addOpenDisputes: [dispute(runId)], addRelearnedUnseen: 1 },
          events: [event({ event: "disputed", runId })],
        }),
      ),
    );

    expect(written.map((outcome) => outcome.applied)).toEqual([true, true]);
    const stored = (await getMemoryEntryState(db, { entryKey }))!;
    expect(stored.openDisputes.map((open) => open.runId).sort()).toEqual(["run-a", "run-b"]);
    expect(stored.relearnedUnseen).toBe(2);
    expect([...(await runEvents("run-a")), ...(await runEvents("run-b"))].map((row) => row.event)).toEqual([
      "disputed",
      "disputed",
    ]);
  });

  it("adds no second dispute for a run that already has one open", async () => {
    const entryKey = await created();
    const dispute = { runId: "run-a", ticketKey: null, outcome: "failed", evidence: "claimed", reason: "first" };
    await changeMemoryEntryState(db, { target: { entryKey }, change: { addOpenDisputes: [dispute] }, events: [event({ event: "disputed" })] });

    await changeMemoryEntryState(db, {
      target: { entryKey },
      change: { addOpenDisputes: [{ ...dispute, reason: "again" }] },
      events: [event({ event: "disputed", runId: "run-a2" })],
    });

    expect((await getMemoryEntryState(db, { entryKey }))!.openDisputes).toEqual([dispute]);
  });

  it("restamps status_since only when the status actually changes", async () => {
    const entryKey = await created();
    const before = (await getMemoryEntryState(db, { entryKey }))!.statusSince;

    await changeMemoryEntryState(db, {
      target: { entryKey },
      change: { status: "active", topic: "testing" },
      events: [event({ event: "reclassified" })],
    });
    expect((await getMemoryEntryState(db, { entryKey }))!.statusSince).toEqual(before);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await changeMemoryEntryState(db, {
      target: { entryKey },
      change: { status: "stale", statusReason: "anchor apps/api/package.json missing" },
      events: [event({ event: "stale", actor: "system", source: "sweep" })],
    });
    const stale = (await getMemoryEntryState(db, { entryKey }))!;
    expect(stale.status).toBe("stale");
    expect(stale.statusSince.getTime()).toBeGreaterThan(before.getTime());
  });
});

describe("listMemoryEntryStates", () => {
  it("lists a subject's entries, narrowed by kind", async () => {
    await recordMemoryEntryState(db, { alias, create: learned, events: [event()] });
    await recordMemoryEntryState(db, {
      alias: { ...alias, kind: "lessons", textHash: sha("flaky test") },
      create: learned,
      events: [event()],
    });
    await recordMemoryEntryState(db, {
      alias: { ...alias, subject: "repo:github:acme/web" },
      create: learned,
      events: [event()],
    });

    expect((await listMemoryEntryStates(db, { subject })).map((row) => row.kind).sort()).toEqual([
      "facts",
      "lessons",
    ]);
    expect((await listMemoryEntryStates(db, { subject, kind: "lessons" })).map((row) => row.textHash)).toEqual([
      sha("flaky test"),
    ]);
  });
});
