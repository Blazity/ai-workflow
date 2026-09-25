import { and, asc, desc, eq, gt, ilike, inArray, isNotNull, lt, notExists, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../client.js";
import { memoryEntryState } from "../memory-entry-state-schema.js";
import { memoryEvents } from "../memory-events-schema.js";
import {
  MEMORY_PROPOSAL_RESOLUTIONS,
  type MemoryEventActor,
  type MemoryEventDetail,
  type MemoryEventEntryKind,
  type MemoryEventKind,
  type MemoryEventSource,
  type MemoryStateKind,
  type MemoryTopic,
} from "../memory-vocabulary.js";

/**
 * The memory ledger's rows, written and read. Callers go through
 * `memory/ledger` (by `memoryLedgerRepository` in `./memory-entry-state.ts`), which cleans the texts of this deployment's secrets on the
 * way in and on the way out and computes the text hashes; this module stores
 * what it is given, minus NUL characters, which Postgres refuses in text and
 * in JSON alike.
 *
 * Every write is ONE statement: production runs neon-http, which cannot open a
 * transaction (`db/client.ts`).
 */

/** One event as the ledger stores it. `textHash` and `previousTextHash` are
 *  the normalised text hashes of `text` and `previousText`; every item text in
 *  `detail.items` carries its own `textHash`. */
export interface MemoryEventRecord {
  readonly event: MemoryEventKind;
  readonly runId: string | null;
  readonly actor: MemoryEventActor;
  readonly source?: MemoryEventSource | null;
  readonly store?: string | null;
  readonly subject?: string | null;
  readonly kind?: MemoryEventEntryKind | null;
  readonly entryId?: string | null;
  readonly entryKey?: string | null;
  readonly text?: string | null;
  readonly textHash?: string | null;
  readonly previousText?: string | null;
  readonly previousTextHash?: string | null;
  readonly reason?: string | null;
  readonly ticketKey?: string | null;
  readonly prRef?: string | null;
  readonly invocationKey?: string | null;
  readonly dedupeKey?: string | null;
  readonly refersTo?: number | null;
  readonly topic?: MemoryTopic | null;
  readonly area?: string | null;
  readonly bytes?: number | null;
  readonly detail?: MemoryEventDetail;
}

export type StoredMemoryEvent = typeof memoryEvents.$inferSelect;

/** A page of rows, and the cursor for the next one; null when this is the end. */
export interface MemoryEventPage {
  readonly events: StoredMemoryEvent[];
  readonly next: number | null;
}

export interface AppendMemoryEventsResult {
  /** Ids of the rows written, in the order given. */
  readonly ids: number[];
  /** Rows not written because their (run, dedupe key) was already recorded. */
  readonly duplicates: number;
}

const DEFAULT_MEMORY_EVENT_PAGE = 50;
const MAX_MEMORY_EVENT_PAGE = 200;

/** Postgres refuses NUL in a text value and in JSON, so memory rows drop it:
 *  from every string, and every key, of the value. */
export function withoutNul<T>(value: T): T {
  if (typeof value === "string") return value.replaceAll("\u0000", "") as T;
  if (Array.isArray(value)) return value.map((item) => withoutNul(item)) as T;
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [withoutNul(key), withoutNul(item)]),
    ) as T;
  }
  return value;
}

/** The hash of every text the row holds: what a forget looks it up by. */
function heldTextHashes(record: MemoryEventRecord): string[] {
  const hashes = new Set<string>();
  if (record.text != null && record.textHash != null) hashes.add(record.textHash);
  if (record.previousText != null && record.previousTextHash != null) {
    hashes.add(record.previousTextHash);
  }
  for (const item of record.detail?.items ?? []) {
    if (item && typeof item.text === "string" && typeof item.textHash === "string") {
      hashes.add(item.textHash);
    }
  }
  return [...hashes];
}

/** The records as one JSON array in the column names the recordset reads. */
function recordsetJson(records: readonly MemoryEventRecord[]): string {
  return JSON.stringify(
    records.map((input, position) => {
      const record = withoutNul(input);
      return {
        position,
        event: record.event,
        run_id: record.runId,
        actor: record.actor,
        source: record.source ?? null,
        store: record.store ?? null,
        subject: record.subject ?? null,
        kind: record.kind ?? null,
        entry_id: record.entryId ?? null,
        entry_key: record.entryKey ?? null,
        text: record.text ?? null,
        text_hash: record.textHash ?? null,
        previous_text: record.previousText ?? null,
        previous_text_hash: record.previousTextHash ?? null,
        text_hashes: heldTextHashes(record),
        reason: record.reason ?? null,
        ticket_key: record.ticketKey ?? null,
        pr_ref: record.prRef ?? null,
        invocation_key: record.invocationKey ?? null,
        dedupe_key: record.dedupeKey ?? null,
        refers_to: record.refersTo ?? null,
        topic: record.topic ?? null,
        area: record.area ?? null,
        bytes: record.bytes ?? null,
        detail: record.detail ?? {},
      };
    }),
  );
}

/**
 * The incoming events as a relation named `incoming_event`, in the order
 * given (`position`). Shared by every statement that appends, so the column
 * list is written once.
 */
export function incomingMemoryEvents(records: readonly MemoryEventRecord[]): SQL {
  return sql`
    SELECT *
    FROM jsonb_to_recordset(${recordsetJson(records)}::jsonb) AS incoming_event(
      position integer, event text, run_id text, actor text, source text, store text, subject text, kind text,
      entry_id text, entry_key uuid, text text, text_hash text, previous_text text,
      previous_text_hash text, text_hashes text[], reason text, ticket_key text, pr_ref text,
      invocation_key text, dedupe_key text, refers_to bigint, topic text, area text,
      bytes integer, detail jsonb
    )`;
}

/** Whether none of the incoming events is already recorded under its
 *  (run, dedupe key). `incoming` names a CTE built from
 *  `incomingMemoryEvents`. */
export function noneAlreadyRecorded(incoming: SQL): SQL {
  return sql`NOT EXISTS (
    SELECT 1
    FROM ${memoryEvents} AS recorded
    JOIN ${incoming} AS incoming_event
      ON coalesce(recorded.run_id, '') = coalesce(incoming_event.run_id, '')
     AND recorded.dedupe_key = incoming_event.dedupe_key
    WHERE recorded.dedupe_key IS NOT NULL
  )`;
}

/** The ledger columns an append writes, in the order the SELECTs below fill. */
export const MEMORY_EVENT_INSERT_COLUMNS = sql.raw(`(
  event, run_id, actor, source, store, subject, kind, entry_id, entry_key, text, text_hash,
  previous_text, previous_text_hash, text_hashes, reason, ticket_key, pr_ref, invocation_key,
  dedupe_key, refers_to, topic, area, bytes, detail
)`);

/**
 * Append events, one statement for the whole call. An event whose
 * (run, dedupe key) is already recorded is skipped and counted, the rest are
 * written; a row the table refuses (an unknown event word, a text without a
 * hash) fails the whole call and writes none of it.
 */
export async function appendMemoryEvents(
  db: Db,
  records: readonly MemoryEventRecord[],
): Promise<AppendMemoryEventsResult> {
  if (records.length === 0) return { ids: [], duplicates: 0 };
  const result = await db.execute(sql`
    INSERT INTO ${memoryEvents} ${MEMORY_EVENT_INSERT_COLUMNS}
    SELECT
      event, run_id, actor, source, store, subject, kind, entry_id, entry_key, text, text_hash,
      previous_text, previous_text_hash, text_hashes, reason, ticket_key, pr_ref, invocation_key,
      dedupe_key, refers_to, topic, area, bytes, detail
    FROM (${incomingMemoryEvents(records)}) AS incoming_event
    ORDER BY position
    ON CONFLICT ((coalesce(run_id, '')), dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
    RETURNING id
  `);
  const ids = rawRows<{ id: number | string }>(result)
    .map((row) => Number(row.id))
    .sort((left, right) => left - right);
  return { ids, duplicates: records.length - ids.length };
}

function pageLimit(requested: number | undefined): number {
  return requested !== undefined && Number.isInteger(requested) && requested > 0
    ? Math.min(requested, MAX_MEMORY_EVENT_PAGE)
    : DEFAULT_MEMORY_EVENT_PAGE;
}

/** One row past the limit is read and never returned: it is what tells a
 *  last page from a full one. */
function toPage(rows: StoredMemoryEvent[], limit: number): MemoryEventPage {
  if (rows.length <= limit) return { events: rows, next: null };
  const events = rows.slice(0, limit);
  return { events, next: events[events.length - 1]!.id };
}

/** A run's memory timeline, oldest first; `after` is the previous page's `next`. */
export async function listRunMemoryEvents(
  db: Db,
  runId: string,
  options: { after?: number; limit?: number } = {},
): Promise<MemoryEventPage> {
  const limit = pageLimit(options.limit);
  const rows = await db
    .select()
    .from(memoryEvents)
    .where(
      and(
        eq(memoryEvents.runId, runId),
        options.after === undefined ? undefined : gt(memoryEvents.id, options.after),
      ),
    )
    .orderBy(asc(memoryEvents.id))
    .limit(limit + 1);
  return toPage(rows, limit);
}

export interface MemoryEventHistoryQuery {
  readonly subject?: string;
  /** The stable key of an entry: its history across every text it had. */
  readonly entryKey?: string;
  /** Every row about this text: holding it as its text, its previous text or
   *  a detail item, or naming the entry that answers to it (`text_hash`). */
  readonly textHash?: string;
  /** The previous page's `next`. */
  readonly before?: number;
  readonly limit?: number;
}

/** History newest first, narrowed by every filter given. */
export async function listMemoryEventHistory(
  db: Db,
  query: MemoryEventHistoryQuery,
): Promise<MemoryEventPage> {
  const limit = pageLimit(query.limit);
  const rows = await db
    .select()
    .from(memoryEvents)
    .where(
      and(
        query.subject === undefined ? undefined : eq(memoryEvents.subject, query.subject),
        query.entryKey === undefined ? undefined : eq(memoryEvents.entryKey, query.entryKey),
        query.textHash === undefined
          ? undefined
          : or(
              eq(memoryEvents.textHash, query.textHash),
              sql`${memoryEvents.textHashes} @> ARRAY[${query.textHash}]::text[]`,
            ),
        query.before === undefined ? undefined : lt(memoryEvents.id, query.before),
      ),
    )
    .orderBy(desc(memoryEvents.id))
    .limit(limit + 1);
  return toPage(rows, limit);
}

/** `%`, `_` and the escape itself, taken literally in an ILIKE pattern. */
function containsPattern(fragment: string): string {
  return `%${withoutNul(fragment).replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * Rows whose text, previous text or any detail item text contains the
 * fragment, case-insensitively, newest first. The stored texts are the
 * redacted ones, so a secret is never found by its value. Not indexed: it
 * reads newest first until the page is full.
 */
export async function searchMemoryEvents(
  db: Db,
  query: { contains: string; subject?: string; before?: number; limit?: number },
): Promise<MemoryEventPage> {
  const limit = pageLimit(query.limit);
  const pattern = containsPattern(query.contains);
  const rows = await db
    .select()
    .from(memoryEvents)
    .where(
      and(
        or(
          ilike(memoryEvents.text, pattern),
          ilike(memoryEvents.previousText, pattern),
          sql`EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(${memoryEvents.detail} -> 'items') = 'array'
                THEN ${memoryEvents.detail} -> 'items' ELSE '[]'::jsonb END
            ) AS item
            WHERE item ->> 'text' ILIKE ${pattern}
          )`,
        ),
        query.subject === undefined ? undefined : eq(memoryEvents.subject, query.subject),
        query.before === undefined ? undefined : lt(memoryEvents.id, query.before),
      ),
    )
    .orderBy(desc(memoryEvents.id))
    .limit(limit + 1);
  return toPage(rows, limit);
}

const resolution = alias(memoryEvents, "resolution");

/**
 * The query behind `listPendingMemoryProposals`, exported so a test can ask
 * the planner how it runs: the proposals recorded for one pull request that no
 * resolution names yet.
 */
export function pendingMemoryProposalsQuery(db: Db, prRef: string) {
  return db
    .select()
    .from(memoryEvents)
    .where(
      and(
        eq(memoryEvents.prRef, prRef),
        eq(memoryEvents.event, "proposed"),
        notExists(
          db
            .select({ id: resolution.id })
            .from(resolution)
            .where(
              and(
                isNotNull(resolution.refersTo),
                eq(resolution.refersTo, memoryEvents.id),
                inArray(resolution.event, [...MEMORY_PROPOSAL_RESOLUTIONS]),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(memoryEvents.id));
}

/**
 * Proposals still waiting for this pull request to merge, oldest first. A
 * proposal is resolved by an applied, held or dropped row that names it in
 * `refers_to`.
 */
export async function listPendingMemoryProposals(
  db: Db,
  prRef: string,
): Promise<StoredMemoryEvent[]> {
  return pendingMemoryProposalsQuery(db, prRef);
}

export interface ForgetMemoryTextInput {
  /** The normalised text hash of what is forgotten. */
  readonly textHash: string;
  /** The subject the entry is forgotten on: its state rows there are deleted. */
  readonly subject: string;
  /** Only this kind's state row; both when omitted. */
  readonly kind?: MemoryStateKind;
  /** The forget's own rows (`removed`, reason `forgotten`). They never hold a
   *  text, whatever is passed: their texts are dropped before the write. */
  readonly events: readonly MemoryEventRecord[];
}

export type ForgetMemoryTextResult =
  | {
      readonly applied: true;
      /** Rows whose text, previous text or a detail item was blanked. */
      readonly blanked: number;
      readonly removedEntryKeys: string[];
      readonly eventIds: number[];
    }
  | { readonly applied: false; readonly why: "duplicate" };

/** A forget row keeps the hashes it names and none of the texts. */
function withoutTexts(record: MemoryEventRecord): MemoryEventRecord {
  const items = record.detail?.items;
  return {
    ...record,
    text: null,
    previousText: null,
    ...(record.detail === undefined
      ? {}
      : {
          detail: {
            ...record.detail,
            ...(items === undefined
              ? {}
              : { items: items.map((item) => ("text" in item ? { ...item, text: null } : item)) }),
          },
        }),
  };
}

/**
 * Forget a text: in ONE statement, blank it in every ledger row that holds it
 * (as text, previous text or a detail item, on any subject, since the text is
 * what was forgotten), delete the entry's state rows on the subject, and
 * record the forget. The hashes stay, so the history still says what happened
 * and when, without the words. This blanking is the only change the ledger
 * ever makes to a row it holds.
 *
 * A row appended after this statement is not touched: the same text learned
 * again later is a new event, recorded as such. When one of the forget's rows
 * is already recorded under its dedupe key, nothing happens at all.
 */
export async function forgetMemoryText(
  db: Db,
  input: ForgetMemoryTextInput,
): Promise<ForgetMemoryTextResult> {
  if (input.events.length === 0) throw new Error("a forget needs at least one event");
  const hash = sql`${input.textHash}::text`;
  const result = await db.execute(sql`
    WITH incoming_event AS (${incomingMemoryEvents(input.events.map(withoutTexts))}),
    fresh AS (SELECT ${noneAlreadyRecorded(sql`incoming_event`)} AS ok),
    blanked AS (
      UPDATE ${memoryEvents} AS held SET
        text = CASE WHEN held.text_hash = ${hash} THEN NULL ELSE held.text END,
        previous_text = CASE WHEN held.previous_text_hash = ${hash} THEN NULL ELSE held.previous_text END,
        detail = CASE WHEN jsonb_typeof(held.detail -> 'items') = 'array'
          THEN jsonb_set(held.detail, '{items}', (
            SELECT coalesce(jsonb_agg(
              CASE WHEN listed.item ->> 'textHash' = ${hash}
                THEN jsonb_set(listed.item, '{text}', 'null'::jsonb) ELSE listed.item END
              ORDER BY listed.position
            ), '[]'::jsonb)
            FROM jsonb_array_elements(held.detail -> 'items') WITH ORDINALITY AS listed(item, position)
          ))
          ELSE held.detail END,
        text_blanked_at = now()
      FROM fresh
      WHERE fresh.ok AND held.text_hashes @> ARRAY[${hash}]
      RETURNING held.id
    ),
    removed AS (
      DELETE FROM ${memoryEntryState} AS gone
      USING fresh
      WHERE fresh.ok
        AND gone.text_hash = ${hash}
        AND gone.subject = ${input.subject}::text
        AND (${input.kind ?? null}::text IS NULL OR gone.kind = ${input.kind ?? null}::text)
      RETURNING gone.entry_key, gone.kind
    ),
    only_removed AS (
      SELECT entry_key, kind FROM removed WHERE (SELECT count(*) FROM removed) = 1
    ),
    appended AS (
      INSERT INTO ${memoryEvents} ${MEMORY_EVENT_INSERT_COLUMNS}
      SELECT
        incoming_event.event, incoming_event.run_id, incoming_event.actor, incoming_event.source,
        incoming_event.store, coalesce(incoming_event.subject, ${input.subject}::text),
        coalesce(incoming_event.kind, (SELECT kind FROM only_removed)), incoming_event.entry_id,
        coalesce(incoming_event.entry_key, (SELECT entry_key FROM only_removed)), NULL,
        coalesce(incoming_event.text_hash, ${hash}), NULL, incoming_event.previous_text_hash,
        incoming_event.text_hashes, incoming_event.reason, incoming_event.ticket_key,
        incoming_event.pr_ref, incoming_event.invocation_key, incoming_event.dedupe_key,
        incoming_event.refers_to, incoming_event.topic, incoming_event.area, incoming_event.bytes,
        incoming_event.detail
      FROM incoming_event, fresh
      WHERE fresh.ok
      ORDER BY incoming_event.position
      RETURNING id
    )
    SELECT
      (SELECT ok FROM fresh) AS fresh,
      (SELECT count(*)::int FROM blanked) AS blanked,
      (SELECT json_agg(entry_key::text) FROM removed) AS removed_entry_keys,
      (SELECT json_agg(id ORDER BY id) FROM appended) AS event_ids
  `);
  const row = rawRows<{
    fresh: boolean;
    blanked: number;
    removed_entry_keys: string[] | null;
    event_ids: Array<number | string> | null;
  }>(result)[0];
  if (!row) throw new Error("memory forget returned no row");
  if (!row.fresh) return { applied: false, why: "duplicate" };
  return {
    applied: true,
    blanked: Number(row.blanked),
    removedEntryKeys: row.removed_entry_keys ?? [],
    eventIds: (row.event_ids ?? []).map(Number),
  };
}

function rawRows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}
