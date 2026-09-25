import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../client.js";
import { createTestDb } from "../test-db.js";
import { changeMemoryEntryState, getMemoryEntryState, recordMemoryEntryState } from "./memory-entry-state.js";
import {
  appendMemoryEvents,
  forgetMemoryText,
  listMemoryEventHistory,
  listPendingMemoryProposals,
  listRunMemoryEvents,
  pendingMemoryProposalsQuery,
  searchMemoryEvents,
  type MemoryEventRecord,
} from "./memory-events.js";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

/** An independent sha256, so no test trusts the code's own hashing. */
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** The database with every `execute` counted: a write is one statement. */
function counting(target: Db): { db: Db; statements: () => number } {
  let statements = 0;
  const db = new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver) as unknown;
      if (property === "execute") {
        return (...args: unknown[]) => {
          statements += 1;
          return (value as (...a: unknown[]) => unknown).apply(object, args);
        };
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(object) : value;
    },
  });
  return { db, statements: () => statements };
}

/** A moment clearly after whatever the database stamped so far. */
async function later(): Promise<Date> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  return new Date();
}

function event(overrides: Partial<MemoryEventRecord> = {}): MemoryEventRecord {
  return {
    event: "added",
    runId: "run-1",
    actor: "run",
    source: "distill",
    store: "builtin",
    subject: "repo:github:acme/api",
    kind: "facts",
    ...overrides,
  };
}

describe("appendMemoryEvents", () => {
  it("appends every row in one call and reads them back as the run's timeline, in order", async () => {
    const appended = await appendMemoryEvents(db, [
      event({ event: "recalled", detail: { ranked: true, items: [{ entryId: "e1", layer: "core" }] } }),
      event({ text: "Use pnpm, not npm", textHash: sha("use pnpm, not npm"), entryId: "e2" }),
      event({ event: "rejected", reason: "url", text: "See https://x", textHash: sha("see https://x") }),
    ]);

    expect(appended.ids).toHaveLength(3);
    expect(appended.duplicates).toBe(0);

    const page = await listRunMemoryEvents(db, "run-1");
    expect(page.events.map((row) => row.event)).toEqual(["recalled", "added", "rejected"]);
    expect(page.next).toBeNull();
    const added = page.events[1]!;
    expect(added).toMatchObject({
      runId: "run-1",
      actor: "run",
      source: "distill",
      store: "builtin",
      subject: "repo:github:acme/api",
      kind: "facts",
      entryId: "e2",
      text: "Use pnpm, not npm",
      textHash: sha("use pnpm, not npm"),
      textBlankedAt: null,
    });
    expect(added.at).toBeInstanceOf(Date);
    expect(page.events[0]!.detail).toEqual({ ranked: true, items: [{ entryId: "e1", layer: "core" }] });
  });

  it("strips NUL characters and lone surrogates from every text, detail string and key, so the row is written", async () => {
    await appendMemoryEvents(db, [
      event({
        text: "Run\u0000 tests \uD83D",
        textHash: sha("run tests \uFFFD"),
        reason: "ok\u0000",
        detail: { items: [{ text: "a\u0000b", textHash: sha("ab") }], note: "x\u0000y", ["k\uDC00"]: "v" },
      }),
      event({ text: "second row", textHash: sha("second row") }),
    ]);

    const [row, second] = (await listRunMemoryEvents(db, "run-1")).events;
    expect(row!.text).toBe("Run tests \uFFFD");
    expect(row!.reason).toBe("ok");
    expect(row!.detail).toEqual({ items: [{ text: "ab", textHash: sha("ab") }], note: "xy", ["k\uFFFD"]: "v" });
    expect(second!.text).toBe("second row");
  });

  it("inserts nothing for a second append with the same (run id, dedupe key), and still appends the rest", async () => {
    await appendMemoryEvents(db, [event({ dedupeKey: "claim:1", text: "one", textHash: sha("one") })]);

    const second = await appendMemoryEvents(db, [
      event({ dedupeKey: "claim:1", text: "one again", textHash: sha("one again") }),
      event({ dedupeKey: "claim:2", text: "two", textHash: sha("two") }),
      // The same key under another run is another event.
      event({ runId: "run-2", dedupeKey: "claim:1", text: "one", textHash: sha("one") }),
    ]);

    expect(second.ids).toHaveLength(2);
    expect(second.duplicates).toBe(1);
    const texts = (await listRunMemoryEvents(db, "run-1")).events.map((row) => row.text);
    expect(texts).toEqual(["one", "two"]);
  });

  it("dedupes events without a run on their key alone, and never dedupes rows without a key", async () => {
    const admin = event({ runId: null, actor: "admin:user-7", source: "human", dedupeKey: "mcp:req-1" });
    const first = await appendMemoryEvents(db, [admin, event({ runId: null, actor: "system" })]);
    const second = await appendMemoryEvents(db, [admin, event({ runId: null, actor: "system" })]);

    expect(first.ids).toHaveLength(2);
    expect(second.ids).toHaveLength(1);
    expect(second.duplicates).toBe(1);
  });

  it("keeps the dedupe keys of events without a run apart per actor, so two admins or two clients never collide", async () => {
    const appended = await appendMemoryEvents(db, [
      event({ runId: null, actor: "admin:user-7", dedupeKey: "req-1" }),
      event({ runId: null, actor: "admin:user-8", dedupeKey: "req-1" }),
      event({ runId: null, actor: "mcp:client-1", dedupeKey: "req-1" }),
      event({ runId: null, actor: "mcp:client-2", dedupeKey: "req-1" }),
    ]);
    const retried = await appendMemoryEvents(db, [event({ runId: null, actor: "admin:user-8", dedupeKey: "req-1" })]);

    expect(appended).toMatchObject({ duplicates: 0 });
    expect(appended.ids).toHaveLength(4);
    expect(retried).toEqual({ ids: [], duplicates: 1 });
  });

  it("refuses a row whose text carries no hash, because a forget could never find it", async () => {
    await expect(appendMemoryEvents(db, [event({ text: "unhashed" })])).rejects.toThrow();
    expect((await listRunMemoryEvents(db, "run-1")).events).toEqual([]);
  });

  it("stores a word outside today's vocabulary: the words are checked in code, so a later stage adds one without a migration", async () => {
    await appendMemoryEvents(db, [event({ event: "proposal_expired" as MemoryEventRecord["event"], topic: "billing" as MemoryEventRecord["topic"] })]);

    expect((await listRunMemoryEvents(db, "run-1")).events.map((row) => [row.event, row.topic])).toEqual([
      ["proposal_expired", "billing"],
    ]);
  });

  it("appends a whole call in one statement", async () => {
    const { db: counted, statements } = counting(db);

    await appendMemoryEvents(counted, [event({ text: "a", textHash: sha("a") }), event({ text: "b", textHash: sha("b") })]);

    expect(statements()).toBe(1);
  });
});

describe("reading the ledger back", () => {
  it("pages a run's timeline forward from a cursor", async () => {
    await appendMemoryEvents(
      db,
      ["a", "b", "c", "d", "e"].map((text) => event({ text, textHash: sha(text) })),
    );

    const first = await listRunMemoryEvents(db, "run-1", { limit: 2 });
    expect(first.events.map((row) => row.text)).toEqual(["a", "b"]);
    expect(first.next).not.toBeNull();
    const second = await listRunMemoryEvents(db, "run-1", { limit: 2, after: first.next! });
    expect(second.events.map((row) => row.text)).toEqual(["c", "d"]);
    const third = await listRunMemoryEvents(db, "run-1", { limit: 2, after: second.next! });
    expect(third.events.map((row) => row.text)).toEqual(["e"]);
    expect(third.next).toBeNull();
  });

  it("stores and matches a subject in its one spelling, however it was written", async () => {
    await appendMemoryEvents(db, [event({ subject: "ticket:Jira:awp-12", text: "t", textHash: sha("t") })]);

    const [row] = (await listMemoryEventHistory(db, { subject: "ticket:jira:AWP-12" })).events;
    expect(row).toMatchObject({ subject: "ticket:jira:AWP-12", text: "t" });
  });

  it("reads a subject's history newest first, with a cursor backwards", async () => {
    await appendMemoryEvents(db, [
      event({ text: "old", textHash: sha("old") }),
      event({ subject: "repo:github:acme/web", text: "elsewhere", textHash: sha("elsewhere") }),
      event({ text: "mid", textHash: sha("mid") }),
      event({ text: "new", textHash: sha("new") }),
    ]);

    const first = await listMemoryEventHistory(db, { subject: "repo:github:acme/api", limit: 2 });
    expect(first.events.map((row) => row.text)).toEqual(["new", "mid"]);
    const second = await listMemoryEventHistory(db, {
      subject: "repo:github:acme/api",
      limit: 2,
      before: first.next!,
    });
    expect(second.events.map((row) => row.text)).toEqual(["old"]);
    expect(second.next).toBeNull();
  });

  it("finds every row about a text by its hash: as text, previous text, detail item, or the entry it names", async () => {
    const hash = sha("use pnpm");
    await appendMemoryEvents(db, [
      event({ text: "Use pnpm", textHash: hash }),
      event({ event: "updated", text: "Use pnpm 9", textHash: sha("use pnpm 9"), previousText: "Use pnpm", previousTextHash: hash }),
      event({ event: "recalled", detail: { items: [{ entryId: "e1", text: "Use pnpm", textHash: hash, cut: "budget" }] } }),
      event({ text: "Unrelated", textHash: sha("unrelated") }),
      // About the entry with that text, holding no text of its own.
      event({ event: "pinned", actor: "admin:user-7", textHash: hash }),
    ]);

    const history = await listMemoryEventHistory(db, { textHash: hash });
    expect(history.events.map((row) => row.event)).toEqual(["pinned", "recalled", "updated", "added"]);
  });

  it("reads an entry's history by its stable key across text changes", async () => {
    const entryKey = "8a6b4d0e-51c9-4b39-9d5b-7c1f3c2a9e10";
    await appendMemoryEvents(db, [
      event({ entryKey, text: "v1", textHash: sha("v1") }),
      event({ entryKey, event: "updated", text: "v2", textHash: sha("v2"), previousText: "v1", previousTextHash: sha("v1") }),
      event({ text: "other", textHash: sha("other") }),
    ]);

    const history = await listMemoryEventHistory(db, { entryKey });
    expect(history.events.map((row) => row.text)).toEqual(["v2", "v1"]);
  });

  it("searches texts, previous texts and detail item texts case-insensitively, taking wildcards literally", async () => {
    await appendMemoryEvents(db, [
      event({ text: "Deploy with Vercel", textHash: sha("deploy with vercel") }),
      event({ event: "updated", text: "x", textHash: sha("x"), previousText: "vercel preview", previousTextHash: sha("vercel preview") }),
      event({ event: "recalled", detail: { items: [{ text: "VERCEL is the host", textHash: sha("vercel is the host") }] } }),
      event({ text: "100% coverage", textHash: sha("100% coverage") }),
      event({ text: "1000 coverage", textHash: sha("1000 coverage") }),
    ]);

    const vercel = await searchMemoryEvents(db, { contains: "vercel" });
    expect(vercel.events.map((row) => row.event)).toEqual(["recalled", "updated", "added"]);
    const percent = await searchMemoryEvents(db, { contains: "0% cov" });
    expect(percent.events.map((row) => row.text)).toEqual(["100% coverage"]);
  });
});

describe("listPendingMemoryProposals", () => {
  it("lists the proposals a pull request still waits for, leaving out resolved ones and other PRs", async () => {
    const pr = "github:acme/api#42";
    const { ids } = await appendMemoryEvents(db, [
      event({ event: "proposed", prRef: pr, dedupeKey: "p1", text: "one", textHash: sha("one") }),
      event({ event: "proposed", prRef: pr, dedupeKey: "p2", text: "two", textHash: sha("two") }),
      event({ event: "proposed", prRef: pr, dedupeKey: "p3", text: "three", textHash: sha("three") }),
      event({ event: "proposed", prRef: "github:acme/api#43", dedupeKey: "p4", text: "four", textHash: sha("four") }),
    ]);
    await appendMemoryEvents(db, [
      event({ event: "proposal_applied", actor: "system", source: "acceptance", prRef: pr, refersTo: ids[0]! }),
      event({ event: "proposal_held", actor: "system", source: "acceptance", prRef: pr, refersTo: ids[2]! }),
      // A review of a proposal is not its resolution.
      event({ event: "reviewed", actor: "admin:user-7", prRef: pr, refersTo: ids[1]! }),
    ]);

    const pending = await listPendingMemoryProposals(db, pr);
    expect(pending.map((row) => row.text)).toEqual(["two"]);
  });

  it("finds a pull request's proposals whichever way its path is cased, and never another PR's", async () => {
    await appendMemoryEvents(db, [
      event({ event: "proposed", prRef: "pr:github:Blazity/Fixture#12", text: "twelve", textHash: sha("twelve") }),
      event({ event: "proposed", prRef: "pr:github:Blazity/Fixture#120", text: "one twenty", textHash: sha("one twenty") }),
      event({ event: "proposed", prRef: "pr:github:Blazity/Other#12", text: "other", textHash: sha("other") }),
    ]);

    // A webhook spells the path as the provider does, a pasted URL as the person did.
    const pending = await listPendingMemoryProposals(db, "pr:github:blazity/fixture#12");

    expect(pending.map((row) => [row.text, row.prRef])).toEqual([["twelve", "pr:github:blazity/fixture#12"]]);
  });

  it("answers from the pull request index, in one query", async () => {
    const pr = "github:acme/api#42";
    await appendMemoryEvents(db, [event({ event: "proposed", prRef: pr, text: "one", textHash: sha("one") })]);

    await db.execute(sql`set enable_seqscan = off`);
    try {
      const plan = await db.execute(sql`explain ${pendingMemoryProposalsQuery(db, pr)}`);
      const text = ((plan as { rows?: Array<Record<string, string>> }).rows ?? [])
        .map((row) => Object.values(row).join(" "))
        .join("\n");
      expect(text).toContain("memory_events_pr_ref_idx");
      expect(text).toContain("memory_events_refers_to_idx");
    } finally {
      await db.execute(sql`set enable_seqscan = on`);
    }
  });
});

describe("forgetMemoryText", () => {
  const leaked = sha("the staging password is hunter2");
  const alias = { subject: "repo:github:acme/api", kind: "facts" as const, textHash: leaked };

  const stateValues = {
    storeIds: { builtin: "b-1" },
    topic: "setup",
    area: "*",
    areaStatus: "resolved",
    areaCandidates: [],
    module: null,
    anchors: [],
    trust: "human",
    pinned: true,
    status: "active",
    statusReason: null,
    openDisputes: [],
    relearnedUnseen: 0,
    originRunId: "run-1",
    originTicket: null,
    lastAdmittedAt: null,
  } as const;

  async function stateFor(target = alias) {
    const written = await recordMemoryEntryState(db, {
      alias: target,
      create: stateValues,
      events: [event({ event: "classified", textHash: target.textHash })],
    });
    if (!written.applied) throw new Error("setup: state not written");
    return written.entryKey;
  }

  it("blanks the text in text, previous text and detail items on its subject, keeps the hashes, and deletes the state row", async () => {
    const entryKey = await stateFor();
    const kept = sha("use pnpm");
    await appendMemoryEvents(db, [
      event({ text: "The staging password is hunter2", textHash: leaked, entryKey }),
      event({
        event: "updated",
        text: "Use pnpm",
        textHash: kept,
        previousText: "The staging password is hunter2",
        previousTextHash: leaked,
      }),
      event({
        event: "recalled",
        detail: {
          ranked: true,
          items: [
            { entryId: "b-1", text: "The staging password is hunter2", textHash: leaked, layer: "core" },
            { entryId: "b-2", text: "Use pnpm", textHash: kept, layer: "core" },
            // An item of the organisation, recalled alongside: not this subject's.
            { entryId: "o-1", subject: "org:acme", text: "The staging password is hunter2", textHash: leaked },
          ],
        },
      }),
      // Another subject's row holding the same text keeps it: the forget was
      // made on this repository, and that one is named so it can be forgotten there too.
      event({ subject: "org:acme", text: "the staging password is hunter2", textHash: leaked }),
      event({ subject: "repo:github:acme/web", previousText: "The staging password is hunter2", previousTextHash: leaked }),
      event({ text: "Use pnpm", textHash: kept }),
    ]);

    const forgotten = await forgetMemoryText(db, {
      textHash: leaked,
      subject: "repo:github:acme/api",
      events: [event({ event: "removed", runId: null, actor: "admin:user-7", source: "human", reason: "forgotten" })],
    });

    expect(forgotten).toMatchObject({
      applied: true,
      blanked: 3,
      removedEntryKeys: [entryKey],
      alsoHeldIn: ["org:acme", "repo:github:acme/web"],
    });
    expect(await getMemoryEntryState(db, { entryKey })).toBeNull();

    const rows = (await listRunMemoryEvents(db, "run-1")).events;
    const [classified, added, updated, recalled, elsewhere, otherRepo, untouched] = rows;
    // The entry's own row with no words in it is left as it was.
    expect(classified!.textBlankedAt).toBeNull();
    expect(added).toMatchObject({ text: null, textHash: leaked });
    expect(added!.textBlankedAt).toBeInstanceOf(Date);
    expect(updated).toMatchObject({ text: "Use pnpm", previousText: null, previousTextHash: leaked });
    expect(recalled!.detail).toEqual({
      ranked: true,
      items: [
        { entryId: "b-1", text: null, textHash: leaked, layer: "core" },
        { entryId: "b-2", text: "Use pnpm", textHash: kept, layer: "core" },
        { entryId: "o-1", subject: "org:acme", text: "The staging password is hunter2", textHash: leaked },
      ],
    });
    expect(elsewhere).toMatchObject({ text: "the staging password is hunter2", textBlankedAt: null });
    expect(otherRepo).toMatchObject({ previousText: "The staging password is hunter2", textBlankedAt: null });
    expect(untouched).toMatchObject({ text: "Use pnpm", textBlankedAt: null });

    // The forget itself is recorded, with the hash and the key, never the text.
    const [removed] = (await listMemoryEventHistory(db, { subject: "repo:github:acme/api", limit: 1 })).events;
    expect(removed).toMatchObject({
      event: "removed",
      reason: "forgotten",
      actor: "admin:user-7",
      text: null,
      textHash: leaked,
      entryKey,
    });
  });

  it("blanks every text and the reason of the forgotten entry's own rows, whatever text they hold", async () => {
    const entryKey = await stateFor();
    await appendMemoryEvents(db, [
      // The entry before an update: another text, the same entry.
      event({ event: "updated", entryKey, text: "The staging password is hunter2", textHash: leaked, previousText: "Staging password: hunter", previousTextHash: sha("staging password: hunter") }),
      event({ event: "disputed", entryKey, reason: "run-9 says hunter2 is wrong", detail: { items: [{ entryId: "b-1", text: "hunter2 rotated", textHash: sha("hunter2 rotated") }] } }),
    ]);

    await forgetMemoryText(db, {
      textHash: leaked,
      subject: "repo:github:acme/api",
      events: [event({ event: "removed", runId: null, actor: "admin:user-7", reason: "forgotten" })],
    });

    const [, updated, disputed] = (await listRunMemoryEvents(db, "run-1")).events;
    expect(updated).toMatchObject({ text: null, previousText: null, previousTextHash: sha("staging password: hunter") });
    expect(disputed).toMatchObject({ reason: null, detail: { items: [{ entryId: "b-1", text: null, textHash: sha("hunter2 rotated") }] } });
    expect(JSON.stringify([updated, disputed])).not.toContain("hunter");
  });

  it("forgets one kind when one is given, leaving the same text as another kind", async () => {
    await appendMemoryEvents(db, [
      event({ kind: "facts", text: "The staging password is hunter2", textHash: leaked }),
      event({ kind: "lessons", text: "The staging password is hunter2", textHash: leaked }),
    ]);

    await forgetMemoryText(db, {
      textHash: leaked,
      subject: "repo:github:acme/api",
      kind: "facts",
      events: [event({ event: "removed", runId: null, actor: "admin:user-7", reason: "forgotten" })],
    });

    const [fact, lesson] = (await listRunMemoryEvents(db, "run-1")).events;
    expect(fact).toMatchObject({ kind: "facts", text: null });
    expect(lesson).toMatchObject({ kind: "lessons", text: "The staging password is hunter2" });
  });

  it("stores blank a text appended after the forget about something that occurred before it, on its subject only", async () => {
    const readBeforeTheForget = new Date(Date.now() - 60_000);
    await forgetMemoryText(db, {
      textHash: leaked,
      subject: "repo:github:acme/api",
      events: [event({ event: "removed", runId: null, actor: "admin:user-7", reason: "forgotten" })],
    });

    // A run that read the text before the forget writes its rows late.
    const { db: counted, statements } = counting(db);
    await appendMemoryEvents(counted, [
      event({ text: "The staging password is hunter2", textHash: leaked, occurredAt: readBeforeTheForget }),
      event({
        event: "updated",
        text: "Use vault",
        textHash: sha("use vault"),
        previousText: "The staging password is hunter2",
        previousTextHash: leaked,
        occurredAt: readBeforeTheForget,
      }),
      event({
        event: "recalled",
        occurredAt: readBeforeTheForget,
        detail: { items: [{ entryId: "b-1", text: "The staging password is hunter2", textHash: leaked }] },
      }),
      event({ subject: "org:acme", text: "The staging password is hunter2", textHash: leaked, occurredAt: readBeforeTheForget }),
    ]);

    expect(statements()).toBe(1);
    const [added, updated, recalled, elsewhere] = (await listRunMemoryEvents(db, "run-1")).events;
    expect(added).toMatchObject({ text: null, textHash: leaked });
    expect(added!.textBlankedAt).toBeInstanceOf(Date);
    expect(added!.occurredAt).toEqual(readBeforeTheForget);
    expect(updated).toMatchObject({ text: "Use vault", previousText: null });
    expect(recalled!.detail).toEqual({ items: [{ entryId: "b-1", text: null, textHash: leaked }] });
    expect(elsewhere).toMatchObject({ subject: "org:acme", text: "The staging password is hunter2", textBlankedAt: null });
  });

  it("keeps a text learned again after the forget visible", async () => {
    await forgetMemoryText(db, {
      textHash: leaked,
      subject: "repo:github:acme/api",
      events: [event({ event: "removed", runId: null, actor: "admin:user-7", reason: "forgotten" })],
    });

    await appendMemoryEvents(db, [event({ text: "The staging password is hunter2", textHash: leaked, occurredAt: await later() })]);

    const [relearned] = (await listRunMemoryEvents(db, "run-1")).events;
    expect(relearned).toMatchObject({ text: "The staging password is hunter2", textBlankedAt: null });
  });

  it("refuses a state write about a text forgotten after its events occurred, and keeps a genuine re-add as a new entry", async () => {
    const firstKey = await stateFor();
    const readBeforeTheForget = new Date(Date.now() - 60_000);
    await forgetMemoryText(db, {
      textHash: leaked,
      subject: "repo:github:acme/api",
      events: [event({ event: "removed", runId: null, actor: "admin:user-7", reason: "forgotten" })],
    });
    const create = (await getMemoryEntryState(db, { alias })) ?? undefined;
    expect(create).toBeUndefined();

    const late = await recordMemoryEntryState(db, {
      alias,
      create: stateValues,
      events: [event({ event: "added", runId: "run-late", text: "The staging password is hunter2", textHash: leaked, occurredAt: readBeforeTheForget })],
    });
    expect(late).toEqual({ applied: false, why: "forgotten", storedVersion: null });
    expect(await getMemoryEntryState(db, { alias })).toBeNull();
    expect((await listRunMemoryEvents(db, "run-late")).events).toEqual([]);

    const readded = await recordMemoryEntryState(db, {
      alias,
      create: stateValues,
      events: [event({ event: "added", runId: "run-new", text: "The staging password is hunter2", textHash: leaked, occurredAt: await later() })],
    });
    expect(readded).toMatchObject({ applied: true, version: 1 });
    if (!readded.applied) return;
    expect(readded.entryKey).not.toBe(firstKey);
    expect((await listRunMemoryEvents(db, "run-new")).events[0]).toMatchObject({ text: "The staging password is hunter2", textBlankedAt: null });
  });

  it("refuses to move an entry onto a text forgotten after the move occurred", async () => {
    await forgetMemoryText(db, {
      textHash: leaked,
      subject: "repo:github:acme/api",
      events: [event({ event: "removed", runId: null, actor: "admin:user-7", reason: "forgotten" })],
    });
    const other = { ...alias, textHash: sha("use pnpm") };
    const otherKey = await stateFor(other);

    const moved = await changeMemoryEntryState(db, {
      target: { entryKey: otherKey },
      moveTo: leaked,
      events: [event({ event: "updated", runId: "run-late", text: "The staging password is hunter2", textHash: leaked, occurredAt: new Date(Date.now() - 60_000) })],
    });

    expect(moved).toEqual({ applied: false, why: "forgotten", storedVersion: 1 });
    expect(await getMemoryEntryState(db, { entryKey: otherKey })).toMatchObject({ textHash: other.textHash });
  });

  it("leaves another subject's state row alone", async () => {
    await stateFor();
    const org = { ...alias, subject: "org:acme" };
    const orgKey = await stateFor(org);

    await forgetMemoryText(db, {
      textHash: leaked,
      subject: "repo:github:acme/api",
      events: [event({ event: "removed", runId: null, actor: "admin:user-7", reason: "forgotten" })],
    });

    expect(await getMemoryEntryState(db, { alias })).toBeNull();
    expect(await getMemoryEntryState(db, { entryKey: orgKey })).not.toBeNull();
  });

  it("never stores a text on the forget's own rows, whatever the caller passed", async () => {
    await forgetMemoryText(db, {
      textHash: leaked,
      subject: "repo:github:acme/api",
      events: [
        event({
          event: "removed",
          runId: null,
          actor: "mcp:client-1",
          reason: "forgotten",
          text: "The staging password is hunter2",
          textHash: leaked,
          detail: { items: [{ text: "The staging password is hunter2", textHash: leaked }] },
        }),
      ],
    });

    const [removed] = (await listMemoryEventHistory(db, { textHash: leaked })).events;
    expect(removed).toMatchObject({ text: null, textHash: leaked, detail: { items: [{ text: null, textHash: leaked }] } });
  });

  it("forgets in one statement", async () => {
    await stateFor();
    const { db: counted, statements } = counting(db);

    await forgetMemoryText(counted, {
      textHash: leaked,
      subject: "repo:github:acme/api",
      events: [event({ event: "removed", runId: null, actor: "admin:user-7", reason: "forgotten" })],
    });

    expect(statements()).toBe(1);
  });

  it("does nothing at all for a forget already recorded under its dedupe key", async () => {
    await stateFor();
    const forget = {
      textHash: leaked,
      subject: "repo:github:acme/api",
      events: [event({ event: "removed" as const, runId: null, actor: "mcp:client-1" as const, reason: "forgotten", dedupeKey: "mcp:req-9" })],
    };
    await forgetMemoryText(db, forget);
    // Learned again after the forget: a new row, which a retry of the old
    // forget must not blank.
    await appendMemoryEvents(db, [event({ text: "The staging password is hunter2", textHash: leaked, occurredAt: await later() })]);

    const retried = await forgetMemoryText(db, forget);

    expect(retried).toEqual({ applied: false, why: "duplicate" });
    const [relearned] = (await listRunMemoryEvents(db, "run-1")).events.slice(-1);
    expect(relearned!.text).toBe("The staging password is hunter2");
  });
});
