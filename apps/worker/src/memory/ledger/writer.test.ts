import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../db/client.js";
import { listMemoryEventHistory, listRunMemoryEvents } from "../../db/repositories/memory-events.js";
import { getMemoryEntryState, memoryLedgerRepository } from "../../db/repositories/memory-entry-state.js";
import { createTestDb } from "../../db/test-db.js";
import { redactConfiguredSecretsInText } from "../../run-observability/sanitizer.js";
import type { KnownSecretsReader } from "../known-secrets.js";
import { MAX_MEMORY_LEDGER_DETAIL_BYTES, MAX_MEMORY_LEDGER_TEXT_BYTES, memoryLedgerWriter, type MemoryLedgerLog } from "./writer.js";

let db: Db;
let lines: Array<{ fields: Record<string, unknown>; message: string }>;
const log: MemoryLedgerLog = (fields, message) => {
  lines.push({ fields, message });
};

beforeEach(async () => {
  db = await createTestDb();
  lines = [];
});

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const REDACTED = "[REDACTED:configured_secret]";
const secret = "sk-live-4f9a2c7e1b";

/** The deployment's secret set, as the port wrapper reads it. */
const knowing =
  (...secrets: string[]): KnownSecretsReader =>
  async () => ({ ok: true, clean: (text) => redactConfiguredSecretsInText(text, secrets) });
const unreadable: KnownSecretsReader = async () => ({ ok: false });

/** A database that fails every call, as a blip would: the repository on it throws. */
const failing = new Proxy({} as Db, {
  get() {
    return () => {
      throw new Error("connection reset");
    };
  },
});

const subject = "repo:github:acme/api";
const base = { runId: "run-1", actor: "run" as const, subject, kind: "facts" as const, store: "builtin", occurredAt: new Date() };
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

describe("memoryLedgerWriter.record", () => {
  it("stores texts without this deployment's secrets, and hashes the text as stored", async () => {
    const ledger = memoryLedgerWriter({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing(secret), log });

    const outcome = await ledger.record([
      {
        ...base,
        event: "updated",
        text: `Deploy with key ${secret}`,
        previousText: `Deploy key is ${secret}`,
        detail: { note: `saw ${secret}`, items: [{ entryId: "e1", text: `uses ${secret}` }] },
      },
    ]);

    expect(outcome).toMatchObject({ ok: true, duplicates: 0 });
    const [row] = (await listRunMemoryEvents(db, "run-1")).events;
    expect(row).toMatchObject({
      text: `Deploy with key ${REDACTED}`,
      textHash: sha(`deploy with key ${REDACTED}`.toLowerCase()),
      previousText: `Deploy key is ${REDACTED}`,
      previousTextHash: sha(`deploy key is ${REDACTED}`.toLowerCase()),
    });
    expect(row!.detail).toEqual({
      note: `saw ${REDACTED}`,
      items: [{ entryId: "e1", text: `uses ${REDACTED}`, textHash: sha(`uses ${REDACTED}`.toLowerCase()) }],
    });
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it("strips NUL characters and hashes what is stored, so the row lands and a forget finds it", async () => {
    const ledger = memoryLedgerWriter({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing(), log });

    await ledger.record([{ ...base, event: "added", text: "Use\u0000 pnpm" }]);

    const [row] = (await listRunMemoryEvents(db, "run-1")).events;
    expect(row).toMatchObject({ text: "Use pnpm", textHash: sha("use pnpm") });
  });

  it("withholds the reason and every detail string but item ids and hashes when the secret set cannot be read", async () => {
    const ledger = memoryLedgerWriter({ repository: () => memoryLedgerRepository(db), knownSecrets: unreadable, log });

    const outcome = await ledger.record([
      {
        ...base,
        event: "rejected",
        text: `key ${secret}`,
        reason: `saw ${secret}`,
        detail: { query: `q ${secret}`, count: 2, items: [{ entryId: "e1", layer: "core", text: `lost ${secret}` }] },
      },
    ]);

    expect(outcome).toMatchObject({ ok: true, withheld: "unreadable" });
    const [row] = (await listRunMemoryEvents(db, "run-1")).events;
    expect(row).toMatchObject({ text: null, reason: null, textHash: sha(`key ${secret}`) });
    expect(row!.detail).toEqual({
      query: null,
      count: 2,
      textWithheld: "unreadable",
      items: [{ entryId: "e1", layer: null, text: null, textHash: sha(`lost ${secret}`) }],
    });
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it("records the event with its texts withheld when the secret set cannot be read, and says so", async () => {
    const ledger = memoryLedgerWriter({ repository: () => memoryLedgerRepository(db), knownSecrets: unreadable, log });

    const outcome = await ledger.record([
      {
        ...base,
        event: "unavailable",
        reason: "store_refused",
        text: `Deploy with key ${secret}`,
        detail: { items: [{ text: `lost ${secret}` }] },
      },
    ]);

    expect(outcome).toMatchObject({ ok: true, withheld: "unreadable" });
    const [row] = (await listRunMemoryEvents(db, "run-1")).events;
    expect(row).toMatchObject({ event: "unavailable", text: null, textHash: sha(`deploy with key ${secret}`) });
    expect(row!.detail).toEqual({
      textWithheld: "unreadable",
      items: [{ text: null, textHash: sha(`lost ${secret}`) }],
    });
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(lines).toEqual([
      { fields: expect.objectContaining({ runId: "run-1", withheld: "unreadable" }), message: expect.any(String) },
    ]);
  });

  it("never throws when the database fails, and logs one line with the run id", async () => {
    const ledger = memoryLedgerWriter({ repository: () => memoryLedgerRepository(failing), knownSecrets: knowing(), log });

    const outcome = await ledger.record([{ ...base, event: "added", text: "Use pnpm" }]);

    expect(outcome).toEqual({ ok: false });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.fields).toEqual({ runId: "run-1", events: ["added"], rows: 1, error: "Error" });
  });

  it("logs a failed write by the error's class, code and constraint, never by its message, which carries the texts", async () => {
    const ledger = memoryLedgerWriter({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing(), log });

    // Names an event that does not exist: the database refuses the row.
    const outcome = await ledger.record([
      { ...base, event: "proposal_applied", refersTo: 424242, text: "The ACME contract ends in May", reason: "ACME renewal" },
    ]);

    expect(outcome).toEqual({ ok: false });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.fields).toMatchObject({
      runId: "run-1",
      events: ["proposal_applied"],
      rows: 1,
      code: "23503",
      constraint: "memory_events_refers_to_memory_events_id_fk",
    });
    expect(JSON.stringify(lines)).not.toContain("ACME");
  });

  it("refuses a word outside the memory vocabulary with one log line, and writes nothing", async () => {
    const ledger = memoryLedgerWriter({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing(), log });

    const outcome = await ledger.record([
      { ...base, event: "added", text: "Use pnpm" },
      { ...base, event: "remembered" as "added", source: "gossip" as "human", text: "Use npm" },
    ]);

    expect(outcome).toEqual({ ok: false });
    expect(lines).toEqual([{ fields: expect.objectContaining({ runId: "run-1", unknown: ["event", "source"] }), message: expect.any(String) }]);
    expect((await listRunMemoryEvents(db, "run-1")).events).toEqual([]);
  });

  it("takes a secret out even when a NUL splits it, and stores a lone surrogate as a replacement character", async () => {
    const ledger = memoryLedgerWriter({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing(secret), log });
    const split = `${secret.slice(0, 7)}\u0000${secret.slice(7)}`;

    const outcome = await ledger.record([
      { ...base, event: "added", text: `Deploy key ${split}` },
      { ...base, event: "added", text: "emoji \ud83d cut", detail: { query: "ticket \udc00 cut" } },
    ]);

    expect(outcome).toMatchObject({ ok: true, duplicates: 0 });
    const [redacted, surrogate] = (await listRunMemoryEvents(db, "run-1")).events;
    expect(redacted).toMatchObject({ text: `Deploy key ${REDACTED}`, textHash: sha(`deploy key ${REDACTED}`.toLowerCase()) });
    expect(surrogate).toMatchObject({ text: "emoji \ufffd cut", textHash: sha("emoji \ufffd cut"), detail: { query: "ticket \ufffd cut" } });
  });

  it("keeps a 300 KB text to 4 KiB on a character boundary, records its size, and hashes it whole", async () => {
    const ledger = memoryLedgerWriter({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing(), log });
    const text = "\u20ac".repeat(100_000);

    await ledger.record([{ ...base, event: "added", text, previousText: text, reason: text }]);

    const [row] = (await listRunMemoryEvents(db, "run-1")).events;
    expect(bytes(text)).toBe(300_000);
    expect(row!.text).toBe("\u20ac".repeat(Math.floor(MAX_MEMORY_LEDGER_TEXT_BYTES / 3)));
    expect(row!.previousText).toBe(row!.text);
    expect(row!.reason).toBe(row!.text);
    expect(row!.bytes).toBe(300_000);
    expect(row!.textHash).toBe(sha(text));
  });

  it("cuts after taking secrets out, so no fragment of a secret survives at the cut", async () => {
    const ledger = memoryLedgerWriter({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing(secret), log });
    // The secret starts a few bytes before the cut and ends after it.
    const text = `${"x".repeat(MAX_MEMORY_LEDGER_TEXT_BYTES - 6)}${secret} tail`;

    await ledger.record([{ ...base, event: "added", text, detail: { items: [{ entryId: "e1", text }] } }]);

    const [row] = (await listRunMemoryEvents(db, "run-1")).events;
    expect(bytes(row!.text!)).toBeLessThanOrEqual(MAX_MEMORY_LEDGER_TEXT_BYTES);
    expect(row!.text).toBe(`${"x".repeat(MAX_MEMORY_LEDGER_TEXT_BYTES - 6)}${REDACTED.slice(0, 6)}`);
    expect(row!.textHash).toBe(sha(`${"x".repeat(MAX_MEMORY_LEDGER_TEXT_BYTES - 6)}${REDACTED} tail`.toLowerCase()));
    expect(JSON.stringify(row)).not.toContain(secret.slice(0, 3));
  });

  it("keeps a 1 MB detail to 32 KiB: its first items in order, and a count of the rest", async () => {
    const ledger = memoryLedgerWriter({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing(), log });
    const items = Array.from({ length: 5000 }, (_, index) => ({ entryId: `e${index}`, text: `fact number ${index} `.padEnd(180, "x") }));
    expect(bytes(JSON.stringify({ items }))).toBeGreaterThan(1_000_000);

    const outcome = await ledger.record([{ ...base, event: "recalled", detail: { ranked: true, items } }]);

    expect(outcome).toMatchObject({ ok: true });
    const [row] = (await listRunMemoryEvents(db, "run-1")).events;
    const kept = row!.detail.items!;
    // Measured by the database, as a reader of the column gets it.
    const printed = await db.execute(sql`SELECT octet_length(detail::text) AS size FROM memory_events WHERE id = ${row!.id}`);
    const size = Number((printed as unknown as { rows: Array<{ size: number }> }).rows[0]!.size);
    expect(size).toBeLessThanOrEqual(MAX_MEMORY_LEDGER_DETAIL_BYTES);
    expect(size).toBeGreaterThan(MAX_MEMORY_LEDGER_DETAIL_BYTES - 400);
    expect(kept.length).toBeGreaterThan(50);
    expect(kept.map((item) => item.entryId)).toEqual(items.slice(0, kept.length).map((item) => item.entryId));
    expect(kept[0]).toEqual({ entryId: "e0", text: items[0]!.text, textHash: sha(items[0]!.text) });
    expect(row!.detail).toMatchObject({ ranked: true, omittedItems: 5000 - kept.length });
  });

  it("never throws when no database can be reached at all", async () => {
    const ledger = memoryLedgerWriter({
      repository: () => {
        throw new Error("DATABASE_URL: Required");
      },
      knownSecrets: knowing(),
      log,
    });

    await expect(ledger.record([{ ...base, event: "added", text: "x" }])).resolves.toEqual({ ok: false });
    expect(lines[0]!.fields).toMatchObject({ runId: "run-1" });
  });

  it("never throws when the log itself fails", async () => {
    const ledger = memoryLedgerWriter({
      repository: () => memoryLedgerRepository(failing),
      knownSecrets: knowing(),
      log: () => {
        throw new Error("stdout closed");
      },
    });

    await expect(ledger.record([{ ...base, event: "added", text: "x" }])).resolves.toEqual({ ok: false });
  });

  it("reports a second append of the same (run, dedupe key) as a duplicate, not a failure", async () => {
    const ledger = memoryLedgerWriter({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing(), log });
    const claim = { ...base, event: "proposed" as const, text: "Use pnpm", dedupeKey: "claim:1" };

    await ledger.record([claim]);
    const again = await ledger.record([claim]);

    expect(again).toMatchObject({ ok: true, ids: [], duplicates: 1 });
    expect(lines).toEqual([]);
  });
});

describe("memoryLedgerWriter entry state", () => {
  it("creates an entry's state with the defaults under its text's alias, with its event", async () => {
    const ledger = memoryLedgerWriter({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing(), log });

    const outcome = await ledger.recordEntryState({
      subject,
      kind: "facts",
      text: "Use pnpm",
      origin: "derived",
      create: { storeIds: { builtin: "b-1" } },
      events: [{ ...base, event: "added", source: "seed", text: "Use pnpm" }],
    });

    expect(outcome).toMatchObject({ ok: true, applied: true, version: 1 });
    const stored = await getMemoryEntryState(db, { alias: { subject, kind: "facts", textHash: sha("use pnpm") } });
    expect(stored).toMatchObject({
      storeIds: { builtin: "b-1" },
      topic: "other",
      area: "unresolved",
      areaStatus: "unresolved",
      trust: "derived",
      pinned: false,
      status: "active",
    });
  });

  it("moves the alias to an updated text, keeping key, trust and pin", async () => {
    const ledger = memoryLedgerWriter({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing(), log });
    const created = await ledger.recordEntryState({
      subject,
      kind: "facts",
      text: "Use pnpm",
      create: { trust: "human", pinned: true },
      events: [{ ...base, event: "added", actor: "admin:user-7", text: "Use pnpm" }],
    });
    if (!created.ok || !created.applied) throw new Error("setup: not created");

    const moved = await ledger.changeEntryState({
      target: { subject, kind: "facts", text: "Use pnpm" },
      moveTo: { text: "Use pnpm 9" },
      events: [{ ...base, event: "updated", actor: "admin:user-7", text: "Use pnpm 9", previousText: "Use pnpm" }],
    });

    expect(moved).toMatchObject({ ok: true, applied: true, entryKey: created.entryKey });
    expect(
      await getMemoryEntryState(db, { alias: { subject, kind: "facts", textHash: sha("use pnpm 9") } }),
    ).toMatchObject({ entryKey: created.entryKey, trust: "human", pinned: true });
  });

  it("cleans a dispute's reason of secrets before it is stored", async () => {
    const ledger = memoryLedgerWriter({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing(secret), log });

    await ledger.recordEntryState({
      subject,
      kind: "facts",
      text: "Use pnpm",
      create: {
        status: "disputed",
        openDisputes: [
          { runId: "run-1", ticketKey: null, outcome: "open", evidence: "claimed", reason: `token ${secret} fails` },
        ],
      },
      events: [{ ...base, event: "disputed" }],
    });

    const stored = await getMemoryEntryState(db, { alias: { subject, kind: "facts", textHash: sha("use pnpm") } });
    expect(stored!.openDisputes[0]!.reason).toBe(`token ${REDACTED} fails`);
  });

  it("cleans an added dispute's reason and appends it to the disputes as stored", async () => {
    const ledger = memoryLedgerWriter({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing(secret), log });
    const first = { runId: "run-0", ticketKey: null, outcome: "failed", evidence: "claimed", reason: "first" };
    await ledger.recordEntryState({
      subject,
      kind: "facts",
      text: "Use pnpm",
      create: { openDisputes: [first] },
      events: [{ ...base, event: "disputed" }],
    });

    await ledger.changeEntryState({
      target: { subject, kind: "facts", text: "Use pnpm" },
      change: {
        addOpenDisputes: [{ runId: "run-2", ticketKey: null, outcome: "failed", evidence: "claimed", reason: `token ${secret}` }],
      },
      events: [{ ...base, runId: "run-2", event: "disputed" }],
    });

    const stored = await getMemoryEntryState(db, { alias: { subject, kind: "facts", textHash: sha("use pnpm") } });
    expect(stored!.openDisputes.map((dispute) => dispute.reason)).toEqual(["first", `token ${REDACTED}`]);
  });

  it("logs a state write refused for a version it did not read or a text another entry answers to, one line each, without a text", async () => {
    const ledger = memoryLedgerWriter({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing(), log });
    await ledger.recordEntryState({ subject, kind: "facts", text: "Use pnpm", events: [{ ...base, event: "added", text: "Use pnpm" }] });
    await ledger.recordEntryState({ subject, kind: "facts", text: "Use npm", events: [{ ...base, event: "added", text: "Use npm" }] });

    const stale = await ledger.changeEntryState({
      target: { subject, kind: "facts", text: "Use pnpm" },
      expectedVersion: 7,
      change: { pinned: true },
      events: [{ ...base, event: "pinned" }],
    });
    const taken = await ledger.changeEntryState({
      target: { subject, kind: "facts", text: "Use pnpm" },
      moveTo: { text: "Use npm" },
      events: [{ ...base, event: "updated", text: "Use npm", previousText: "Use pnpm" }],
    });

    expect(stale).toMatchObject({ ok: true, applied: false, why: "version_mismatch" });
    expect(taken).toMatchObject({ ok: true, applied: false, why: "alias_taken" });
    expect(lines.map((line) => line.fields.why)).toEqual(["version_mismatch", "alias_taken"]);
    expect(JSON.stringify(lines)).not.toContain("npm");
  });

  it("refuses a state write with a word outside the vocabulary", async () => {
    const ledger = memoryLedgerWriter({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing(), log });

    const outcome = await ledger.recordEntryState({
      subject,
      kind: "facts",
      text: "Use pnpm",
      create: { topic: "billing" as "other" },
      events: [{ ...base, event: "classified" }],
    });

    expect(outcome).toEqual({ ok: false });
    expect(lines[0]!.fields).toMatchObject({ unknown: ["topic"] });
    expect(await getMemoryEntryState(db, { alias: { subject, kind: "facts", textHash: sha("use pnpm") } })).toBeNull();
  });

  it("still writes a state change when the secret set cannot be read, with every text withheld", async () => {
    const ledger = memoryLedgerWriter({ repository: () => memoryLedgerRepository(db), knownSecrets: unreadable, log });

    const outcome = await ledger.recordEntryState({
      subject,
      kind: "facts",
      text: `Deploy with ${secret}`,
      create: {
        pinned: true,
        openDisputes: [
          { runId: "run-1", ticketKey: null, outcome: "open", evidence: "claimed", reason: `token ${secret}` },
        ],
      },
      events: [{ ...base, event: "pinned", actor: "admin:user-7", text: `Deploy with ${secret}` }],
    });

    expect(outcome).toMatchObject({ ok: true, applied: true, withheld: "unreadable" });
    const alias = { subject, kind: "facts" as const, textHash: sha(`deploy with ${secret}`) };
    const stored = await getMemoryEntryState(db, { alias });
    expect(stored).toMatchObject({ pinned: true });
    expect(stored!.openDisputes[0]!.reason).toBeNull();
    const [pinned] = (await listRunMemoryEvents(db, "run-1")).events;
    expect(pinned).toMatchObject({ text: null, textHash: alias.textHash, detail: { textWithheld: "unreadable" } });
    expect(JSON.stringify([stored, pinned])).not.toContain(secret);
  });

  it("never throws out of a state write or a forget when the database fails", async () => {
    const ledger = memoryLedgerWriter({ repository: () => memoryLedgerRepository(failing), knownSecrets: knowing(), log });

    await expect(
      ledger.recordEntryState({
        subject,
        kind: "facts",
        text: "x",
        create: {},
        events: [{ ...base, event: "added", text: "x" }],
      }),
    ).resolves.toEqual({ ok: false });
    await expect(
      ledger.changeEntryState({
        target: { entryKey: "8a6b4d0e-51c9-4b39-9d5b-7c1f3c2a9e10" },
        change: { pinned: true },
        events: [{ ...base, event: "pinned" }],
      }),
    ).resolves.toEqual({ ok: false });
    await expect(
      ledger.forget({
        subject,
        text: "x",
        actor: "admin:user-7",
        runId: null,
      }),
    ).resolves.toEqual({ ok: false });
    expect(lines).toHaveLength(3);
  });
});

describe("memoryLedgerWriter.forget", () => {
  it("forgets a text by its normalised hash on its subject, blanking the rows that held it and deleting its state", async () => {
    const ledger = memoryLedgerWriter({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing(), log });
    await ledger.recordEntryState({
      subject,
      kind: "facts",
      text: "The staging password is hunter2",
      create: {},
      events: [{ ...base, event: "added", text: "The staging password is hunter2" }],
    });
    await ledger.record([{ ...base, runId: "run-org", subject: "org:acme", event: "added", text: "The staging password is hunter2" }]);

    const outcome = await ledger.forget({
      subject,
      text: "- the staging password is hunter2.",
      actor: "admin:user-7",
      runId: null,
      store: "builtin",
    });
    // A run that read the text before the forget records it late.
    await ledger.record([{ ...base, event: "recalled", detail: { items: [{ entryId: "b-1", text: "The staging password is hunter2" }] } }]);

    expect(outcome).toMatchObject({ ok: true, applied: true, blanked: 1, alsoHeldIn: ["org:acme"] });
    const [, late] = (await listRunMemoryEvents(db, "run-1")).events;
    expect(late!.detail.items).toEqual([{ entryId: "b-1", text: null, textHash: sha("the staging password is hunter2") }]);
    const tombstone = (await listMemoryEventHistory(db, { subject })).events.find((row) => row.event === "removed");
    expect(tombstone).toMatchObject({ event: "removed", reason: "forgotten", text: null, textHash: sha("the staging password is hunter2") });
    const [added] = (await listRunMemoryEvents(db, "run-1")).events;
    expect(added).toMatchObject({ text: null, textHash: sha("the staging password is hunter2") });
    expect(
      await getMemoryEntryState(db, {
        alias: { subject, kind: "facts", textHash: sha("the staging password is hunter2") },
      }),
    ).toBeNull();
  });
});
