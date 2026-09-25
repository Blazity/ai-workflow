import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  MemoryEventActor,
  MemoryEventDetail,
  MemoryEventEntryKind,
  MemoryEventKind,
  MemoryEventSource,
  MemoryTopic,
} from "./memory-vocabulary.js";

/**
 * The memory ledger: one append-only row per memory event, so a run has one
 * timeline and "why did the agent not remember X" has an answer.
 *
 * Texts are stored redacted and without NUL characters, and are redacted again
 * on every read (`memory/ledger`). The only change ever made to a stored row is
 * blanking its texts when someone forgets that text on a subject: `text`,
 * `previous_text` and every `detail.items[].text` whose hash matches go to
 * null, the hashes stay, and `text_blanked_at` records when. `text_hashes`
 * lists the hash of every text the row held, so that forget is one indexed
 * statement. The forget's own row (`removed`, reason `forgotten`) is the
 * tombstone: a row appended later about something that occurred before it is
 * stored with those texts already blank.
 *
 * The words (`event`, `actor`, `source`, `kind`, `topic`) are plain text,
 * checked in code against `memory-vocabulary.ts`, so a later stage adds a word
 * without a migration.
 *
 * Every write is ONE statement: production runs neon-http, which cannot open
 * a transaction (`db/client.ts`).
 */
export const memoryEvents = pgTable(
  "memory_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** When the row was written. */
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    /** When what it records happened: the store call, the recall. A row can be
     *  written late; a forget compares against this, not against `at`. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    event: text("event").$type<MemoryEventKind>().notNull(),
    /** Null for an event no run caused: a person, an MCP client, a sweep. */
    runId: text("run_id"),
    actor: text("actor").$type<MemoryEventActor>().notNull(),
    source: text("source").$type<MemoryEventSource>(),
    /** The store the event happened in (`builtin`, `mem0`, ...), when one did. */
    store: text("store"),
    /** The subject key the entry belongs to (`repo:<provider>:<path>`,
     *  `org:<owner>`, or the ticket subject of a notebook), stored and
     *  compared in `canonicalSubjectKey`'s spelling. */
    subject: text("subject"),
    kind: text("kind").$type<MemoryEventEntryKind>(),
    /** The store's own id of the entry. */
    entryId: text("entry_id"),
    /** The stable key of `memory_entry_state`; kept after that row is deleted. */
    entryKey: uuid("entry_key"),
    text: text("text"),
    textHash: text("text_hash"),
    previousText: text("previous_text"),
    previousTextHash: text("previous_text_hash"),
    textHashes: text("text_hashes").array().notNull().default(sql`'{}'::text[]`),
    reason: text("reason"),
    ticketKey: text("ticket_key"),
    /** The pull request a proposal waits for, as its subject key
     *  (`prSubjectKey`), stored and compared in `canonicalSubjectKey`'s spelling. */
    prRef: text("pr_ref"),
    invocationKey: text("invocation_key"),
    /** Makes an append idempotent: one row per (run, key), or per (actor, key)
     *  for an event without a run, so two admins or two MCP clients never
     *  share a key. */
    dedupeKey: text("dedupe_key"),
    /** The event this one answers: a proposal's resolution names the proposal. */
    refersTo: bigint("refers_to", { mode: "number" }).references(
      (): AnyPgColumn => memoryEvents.id,
    ),
    topic: text("topic").$type<MemoryTopic>(),
    area: text("area"),
    bytes: integer("bytes"),
    detail: jsonb("detail").$type<MemoryEventDetail>().notNull().default(sql`'{}'::jsonb`),
    textBlankedAt: timestamp("text_blanked_at", { withTimezone: true }),
  },
  (t) => [
    index("memory_events_run_idx").on(t.runId, t.id).where(sql`${t.runId} is not null`),
    index("memory_events_subject_idx").on(t.subject, t.id).where(sql`${t.subject} is not null`),
    index("memory_events_entry_key_idx").on(t.entryKey, t.id).where(sql`${t.entryKey} is not null`),
    index("memory_events_text_hash_idx").on(t.textHash).where(sql`${t.textHash} is not null`),
    // Forget asks which rows hold a text anywhere; without this it would read
    // every row's texts and detail.
    index("memory_events_text_hashes_idx").using("gin", t.textHashes),
    // Every append asks whether a forget newer than what it records covers
    // its texts.
    index("memory_events_forgotten_idx")
      .on(t.subject, t.textHash, t.at)
      .where(sql`${t.event} = 'removed' and ${t.reason} = 'forgotten'`),
    // Pending proposals of one pull request, and whatever else names it.
    index("memory_events_pr_ref_idx").on(t.prRef, t.event, t.id).where(sql`${t.prRef} is not null`),
    index("memory_events_refers_to_idx").on(t.refersTo, t.event).where(sql`${t.refersTo} is not null`),
    // The expression is what lets an event without a run be idempotent too:
    // two NULL run ids are never equal in a plain unique index. The actor
    // scopes those keys to whoever sent them.
    uniqueIndex("memory_events_dedupe_unique")
      .on(sql`(coalesce(${t.runId}, ${t.actor}))`, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
    check("memory_events_text_hash_check", sql`${t.textHash} ~ '^[0-9a-f]{64}$'`),
    check("memory_events_previous_text_hash_check", sql`${t.previousTextHash} ~ '^[0-9a-f]{64}$'`),
    // A text nobody can find by its hash is a text a forget cannot blank.
    check(
      "memory_events_text_hashed_check",
      sql`(${t.text} is null or ${t.textHash} is not null) and (${t.previousText} is null or ${t.previousTextHash} is not null)`,
    ),
    check("memory_events_detail_check", sql`jsonb_typeof(${t.detail}) = 'object'`),
    check("memory_events_bytes_check", sql`${t.bytes} >= 0`),
  ],
);
