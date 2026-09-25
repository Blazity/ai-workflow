import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../db/client.js";
import { listRunMemoryEvents } from "../../db/repositories/memory-events.js";
import { getMemoryEntryState, memoryLedgerRepository } from "../../db/repositories/memory-entry-state.js";
import { createTestDb } from "../../db/test-db.js";
import { redactConfiguredSecretsInText } from "../../run-observability/sanitizer.js";
import type { KnownSecretsReader } from "../known-secrets.js";
import { memoryLedgerWriter, type MemoryLedgerLog } from "./writer.js";

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
const base = { runId: "run-1", actor: "run" as const, subject, kind: "facts" as const, store: "builtin" };

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
    expect(lines[0]!.fields).toMatchObject({ runId: "run-1", events: ["added"], err: "connection reset" });
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
  it("forgets a text by its normalised hash, blanking every row that held it and deleting its state", async () => {
    const ledger = memoryLedgerWriter({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing(), log });
    await ledger.recordEntryState({
      subject,
      kind: "facts",
      text: "The staging password is hunter2",
      create: {},
      events: [{ ...base, event: "added", text: "The staging password is hunter2" }],
    });

    const outcome = await ledger.forget({
      subject,
      text: "- the staging password is hunter2.",
      actor: "admin:user-7",
      runId: null,
      store: "builtin",
    });

    expect(outcome).toMatchObject({ ok: true, applied: true, blanked: 1 });
    const [added] = (await listRunMemoryEvents(db, "run-1")).events;
    expect(added).toMatchObject({ text: null, textHash: sha("the staging password is hunter2") });
    expect(
      await getMemoryEntryState(db, {
        alias: { subject, kind: "facts", textHash: sha("the staging password is hunter2") },
      }),
    ).toBeNull();
  });
});
