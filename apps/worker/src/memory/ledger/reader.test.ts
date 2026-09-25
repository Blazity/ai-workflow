import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../db/client.js";
import { memoryLedgerRepository } from "../../db/repositories/memory-entry-state.js";
import { createTestDb } from "../../db/test-db.js";
import { redactConfiguredSecretsInText } from "../../run-observability/sanitizer.js";
import type { KnownSecretsReader } from "../known-secrets.js";
import { memoryLedgerReader } from "./reader.js";
import { memoryLedgerWriter } from "./writer.js";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const REDACTED = "[REDACTED:configured_secret]";
const secret = "ghp_later9d2f7a1c4e";
const knowing =
  (...secrets: string[]): KnownSecretsReader =>
  async () => ({ ok: true, clean: (text) => redactConfiguredSecretsInText(text, secrets) });
const quiet = () => undefined;

const subject = "repo:github:acme/api";
const base = { runId: "run-1", actor: "run" as const, subject, kind: "facts" as const, store: "builtin", occurredAt: new Date() };

/** Written while the value was not yet a known secret. */
async function writtenBeforeItWasASecret() {
  const writer = memoryLedgerWriter({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing(), log: quiet });
  await writer.record([
    {
      ...base,
      event: "updated",
      text: `Push with ${secret}`,
      previousText: `Token is ${secret}`,
      detail: { items: [{ entryId: "e1", text: `uses ${secret}` }], note: `saw ${secret}` },
    },
  ]);
}

describe("memoryLedgerReader", () => {
  it("cleans every text again on the way out, with a secret added after the write", async () => {
    await writtenBeforeItWasASecret();
    const reader = memoryLedgerReader({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing(secret) });

    const timeline = await reader.runTimeline("run-1");

    expect(timeline.ok).toBe(true);
    if (!timeline.ok) return;
    const [row] = timeline.events;
    expect(row).toMatchObject({ text: `Push with ${REDACTED}`, previousText: `Token is ${REDACTED}` });
    expect(row!.detail).toMatchObject({ note: `saw ${REDACTED}`, items: [{ entryId: "e1", text: `uses ${REDACTED}` }] });
    expect(JSON.stringify(timeline)).not.toContain(secret);
  });

  it("reads nothing when the secret set cannot be read", async () => {
    await writtenBeforeItWasASecret();
    const reader = memoryLedgerReader({ repository: () => memoryLedgerRepository(db), knownSecrets: async () => ({ ok: false }) });

    const timeline = await reader.runTimeline("run-1");

    expect(timeline).toEqual({ ok: false, code: "unavailable", detail: expect.any(String) });
    expect(JSON.stringify(timeline)).not.toContain(secret);
  });

  it("finds a text's history by the text itself, however it is spelled", async () => {
    const writer = memoryLedgerWriter({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing(), log: quiet });
    await writer.record([
      { ...base, event: "added", text: "Use pnpm" },
      { ...base, event: "added", text: "Use npm" },
    ]);
    const reader = memoryLedgerReader({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing() });

    const history = await reader.history({ text: "- use PNPM." });

    expect(history.ok && history.events.map((row) => row.text)).toEqual(["Use pnpm"]);
  });

  it("searches by a fragment and cleans what it returns", async () => {
    await writtenBeforeItWasASecret();
    const reader = memoryLedgerReader({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing(secret) });

    const found = await reader.search({ contains: "push with" });

    expect(found.ok && found.events.map((row) => row.text)).toEqual([`Push with ${REDACTED}`]);
  });

  it("lists the proposals a pull request still waits for", async () => {
    const writer = memoryLedgerWriter({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing(), log: quiet });
    const pr = "github:acme/api#42";
    const proposed = await writer.record([
      { ...base, event: "proposed", prRef: pr, text: "Use pnpm", dedupeKey: "p1" },
      { ...base, event: "proposed", prRef: pr, text: "Run vitest", dedupeKey: "p2" },
    ]);
    if (!proposed.ok) throw new Error("setup: proposals not recorded");
    await writer.record([
      { ...base, event: "proposal_dropped", actor: "system", prRef: pr, refersTo: proposed.ids[0]!, reason: "pr_closed_unmerged" },
    ]);
    const reader = memoryLedgerReader({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing() });

    const pending = await reader.pendingProposals(pr);

    expect(pending.ok && pending.events.map((row) => row.text)).toEqual(["Run vitest"]);
  });

  it("reads an entry without a state row as the defaults, and a stored one as stored", async () => {
    const writer = memoryLedgerWriter({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing(), log: quiet });
    await writer.recordEntryState({
      subject,
      kind: "facts",
      text: "Use pnpm",
      create: { trust: "human", pinned: true },
      events: [{ ...base, event: "pinned", actor: "admin:user-7" }],
    });
    const reader = memoryLedgerReader({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing() });

    const stored = await reader.entryState({ subject, kind: "facts", text: "use pnpm" });
    const missing = await reader.entryState({ subject, kind: "facts", text: "Use npm" }, "derived");

    expect(stored).toMatchObject({ ok: true, state: { stored: true, trust: "human", pinned: true } });
    expect(missing).toMatchObject({
      ok: true,
      state: {
        stored: false,
        entryKey: null,
        textHash: sha("use npm"),
        topic: "other",
        area: "unresolved",
        trust: "derived",
        status: "active",
        pinned: false,
      },
    });
  });

  it("cleans a stored dispute's reason on the way out", async () => {
    const writer = memoryLedgerWriter({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing(), log: quiet });
    await writer.recordEntryState({
      subject,
      kind: "facts",
      text: "Use pnpm",
      create: {
        status: "disputed",
        openDisputes: [{ runId: "run-1", ticketKey: null, outcome: "open", evidence: "claimed", reason: `fails with ${secret}` }],
      },
      events: [{ ...base, event: "disputed" }],
    });
    const reader = memoryLedgerReader({ repository: () => memoryLedgerRepository(db), knownSecrets: knowing(secret) });

    const listed = await reader.entryStates({ subject });

    expect(listed.ok && listed.states.map((state) => state.openDisputes[0]?.reason)).toEqual([
      `fails with ${REDACTED}`,
    ]);
  });
});
