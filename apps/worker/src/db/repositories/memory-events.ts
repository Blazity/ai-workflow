import { canonicalSubjectKey } from "@shared/contracts";
import { and, asc, desc, eq, gt, ilike, inArray, isNotNull, lt, notExists, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../client.js";
import { memoryEntryState } from "../memory-entry-state-schema.js";
import { memoryEvents } from "../memory-events-schema.js";
import { storable } from "../memory-storable.js";
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
 * `memory/ledger` (by `memoryLedgerRepository` in `./memory-entry-state.ts`),
 * which checks the words, cleans the texts of this deployment's secrets on the
 * way in and on the way out, caps them and computes the text hashes; this
 * module stores what it is given, made storable again as a backstop
 * (`../memory-storable.ts`), with subjects and pull request keys in their one
 * spelling (`canonicalSubjectKey`).
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
  /** The pull request's subject key (`prSubjectKey`). */
  readonly prRef?: string | null;
  readonly invocationKey?: string | null;
  readonly dedupeKey?: string | null;
  readonly refersTo?: number | null;
  readonly topic?: MemoryTopic | null;
  readonly area?: string | null;
  readonly bytes?: number | null;
  readonly detail?: MemoryEventDetail;
  /** When it happened (the store call, the recall); the time of the write
   *  when omitted. A forget blanks the texts of a row that occurred before it,
   *  however late that row is written. */
  readonly occurredAt?: Date | null;
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

/** A subject or pull request key in the spelling the ledger stores and matches. */
export function canonicalMemorySubject<T extends string | null | undefined>(key: T): T {
  return (typeof key === "string" ? canonicalSubjectKey(key) : key) as T;
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

/** Items may name their own subject (a recall across a repository and its
 *  organisation); it is matched in the same spelling as the row's. */
function withCanonicalItemSubjects(detail: MemoryEventDetail | undefined): MemoryEventDetail {
  if (detail?.items === undefined) return detail ?? {};
  return {
    ...detail,
    items: detail.items.map((item) =>
      item && typeof item.subject === "string" ? { ...item, subject: canonicalSubjectKey(item.subject) } : item,
    ),
  };
}

/** The records as one JSON array in the column names the recordset reads. */
function recordsetJson(records: readonly MemoryEventRecord[]): string {
  return JSON.stringify(
    records.map((input, position) => {
      const record = storable(input);
      return {
        position,
        event: record.event,
        run_id: record.runId,
        actor: record.actor,
        source: record.source ?? null,
        store: record.store ?? null,
        subject: canonicalMemorySubject(record.subject ?? null),
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
        pr_ref: canonicalMemorySubject(record.prRef ?? null),
        invocation_key: record.invocationKey ?? null,
        dedupe_key: record.dedupeKey ?? null,
        refers_to: record.refersTo ?? null,
        topic: record.topic ?? null,
        area: record.area ?? null,
        bytes: record.bytes ?? null,
        detail: withCanonicalItemSubjects(record.detail),
        occurred_at: input.occurredAt ? input.occurredAt.toISOString() : null,
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
      bytes integer, detail jsonb, occurred_at timestamptz
    )`;
}

/** Whether none of the incoming events is already recorded under its
 *  (run, dedupe key), or (actor, dedupe key) without a run. `incoming` names a
 *  CTE built from `incomingMemoryEvents`. */
export function noneAlreadyRecorded(incoming: SQL): SQL {
  return sql`NOT EXISTS (
    SELECT 1
    FROM ${memoryEvents} AS recorded
    JOIN ${incoming} AS incoming_event
      ON coalesce(recorded.run_id, recorded.actor) = coalesce(incoming_event.run_id, incoming_event.actor)
     AND recorded.dedupe_key = incoming_event.dedupe_key
    WHERE recorded.dedupe_key IS NOT NULL
  )`;
}

/** The earliest time any incoming event occurred: what a state write is
 *  compared with a forget by. `incoming` names a CTE built from
 *  `incomingMemoryEvents`. */
export function earliestOccurrence(incoming: SQL): SQL {
  return sql`(SELECT min(coalesce(occurred_at, now())) FROM ${incoming})`;
}

/**
 * Whether a forget recorded after `occurredAt` covers the text with this hash
 * on this subject and kind: its tombstone, the forget's own `removed` row with
 * reason `forgotten`. A null subject or kind is covered by a forget on any, as
 * the forget itself blanked such rows.
 */
export function forgottenAfter(subject: SQL, kind: SQL, textHash: SQL, occurredAt: SQL): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM ${memoryEvents} AS tombstone
    WHERE tombstone.event = 'removed'
      AND tombstone.reason = 'forgotten'
      AND tombstone.subject = coalesce(${subject}, tombstone.subject)
      AND tombstone.text_hash = ${textHash}
      AND (tombstone.kind IS NULL OR coalesce(${kind}, tombstone.kind) = tombstone.kind)
      AND tombstone.at > ${occurredAt}
  )`;
}

/**
 * The one INSERT every append goes through. `rows` is a SELECT with the
 * columns of `incomingMemoryEvents`, resolved to what is stored. Every text,
 * previous text and item text that a later forget covers (`forgottenAfter`) is
 * stored blank, with `text_blanked_at` set: a run that read a text before an
 * admin forgot it cannot write the words back by appending late.
 */
export function insertMemoryEvents(rows: SQL, onConflict: SQL = sql``): SQL {
  const occurred = sql`coalesce(resolved.occurred_at, now())`;
  return sql`
    INSERT INTO ${memoryEvents} (
      event, run_id, actor, source, store, subject, kind, entry_id, entry_key, text, text_hash,
      previous_text, previous_text_hash, text_hashes, reason, ticket_key, pr_ref, invocation_key,
      dedupe_key, refers_to, topic, area, bytes, detail, occurred_at, text_blanked_at
    )
    SELECT
      resolved.event, resolved.run_id, resolved.actor, resolved.source, resolved.store,
      resolved.subject, resolved.kind, resolved.entry_id, resolved.entry_key,
      CASE WHEN screen.text_gone THEN NULL ELSE resolved.text END,
      resolved.text_hash,
      CASE WHEN screen.previous_text_gone THEN NULL ELSE resolved.previous_text END,
      resolved.previous_text_hash, resolved.text_hashes, resolved.reason, resolved.ticket_key,
      resolved.pr_ref, resolved.invocation_key, resolved.dedupe_key, resolved.refers_to,
      resolved.topic, resolved.area, resolved.bytes,
      CASE WHEN screen.items_gone THEN jsonb_set(resolved.detail, '{items}', screen.items)
        ELSE resolved.detail END,
      ${occurred},
      CASE WHEN screen.text_gone OR screen.previous_text_gone OR screen.items_gone THEN now() END
    FROM (${rows}) AS resolved
    CROSS JOIN LATERAL (
      SELECT
        resolved.text IS NOT NULL
          AND ${forgottenAfter(sql`resolved.subject`, sql`resolved.kind`, sql`resolved.text_hash`, occurred)}
          AS text_gone,
        resolved.previous_text IS NOT NULL
          AND ${forgottenAfter(sql`resolved.subject`, sql`resolved.kind`, sql`resolved.previous_text_hash`, occurred)}
          AS previous_text_gone,
        coalesce(bool_or(listed.gone), false) AS items_gone,
        coalesce(jsonb_agg(
          CASE WHEN listed.gone THEN jsonb_set(listed.item, '{text}', 'null'::jsonb) ELSE listed.item END
          ORDER BY listed.position
        ), '[]'::jsonb) AS items
      FROM (
        SELECT
          element.item,
          element.position,
          coalesce(jsonb_typeof(element.item -> 'text') = 'string', false)
            AND ${forgottenAfter(
              sql`coalesce(element.item ->> 'subject', resolved.subject)`,
              sql`coalesce(element.item ->> 'kind', resolved.kind)`,
              sql`element.item ->> 'textHash'`,
              occurred,
            )} AS gone
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(resolved.detail -> 'items') = 'array'
            THEN resolved.detail -> 'items' ELSE '[]'::jsonb END
        ) WITH ORDINALITY AS element(item, position)
      ) AS listed
    ) AS screen
    ORDER BY resolved.position
    ${onConflict}
    RETURNING id`;
}

/**
 * Whether a write failed because another write recorded one of its events
 * first: the race the up-front `noneAlreadyRecorded` cannot see, answered by
 * the unique index. Read from the driver's error, which drizzle wraps in its
 * own (`cause`).
 */
export function isDedupeRace(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth += 1) {
    const { code, constraint, cause } = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (code === "23505" && constraint === "memory_events_dedupe_unique") return true;
    current = cause;
  }
  return false;
}

/** A write whose own events share a dedupe key would fail on the unique
 *  index and read as a race it is not, so it is refused before it is sent. */
export function requireDistinctDedupeKeys(records: readonly MemoryEventRecord[]): void {
  const seen = new Set<string>();
  for (const record of records) {
    if (record.dedupeKey == null) continue;
    const key = JSON.stringify([record.runId ?? record.actor, record.dedupeKey]);
    if (seen.has(key)) throw new Error("two events of one memory write share a dedupe key");
    seen.add(key);
  }
}

/**
 * Append events, one statement for the whole call. An event whose
 * (run, dedupe key) is already recorded is skipped and counted, the rest are
 * written; a row the table refuses (a text without a hash, a detail that is
 * not an object) fails the whole call and writes none of it.
 */
export async function appendMemoryEvents(
  db: Db,
  records: readonly MemoryEventRecord[],
): Promise<AppendMemoryEventsResult> {
  if (records.length === 0) return { ids: [], duplicates: 0 };
  const result = await db.execute(
    insertMemoryEvents(
      incomingMemoryEvents(records),
      sql`ON CONFLICT ((coalesce(run_id, actor)), dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    ),
  );
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
  return { events, next: events.at(-1)!.id };
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
        query.subject === undefined
          ? undefined
          : eq(memoryEvents.subject, canonicalMemorySubject(query.subject)),
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
  return `%${storable(fragment).replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
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
        query.subject === undefined
          ? undefined
          : eq(memoryEvents.subject, canonicalMemorySubject(query.subject)),
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
 * resolution names yet. The key is matched in `canonicalSubjectKey`'s
 * spelling, so a webhook's `Blazity/Fixture` finds what a pasted URL's
 * `blazity/fixture` recorded.
 */
export function pendingMemoryProposalsQuery(db: Db, prRef: string) {
  return db
    .select()
    .from(memoryEvents)
    .where(
      and(
        eq(memoryEvents.prRef, canonicalMemorySubject(prRef)),
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
  /** The subject the text is forgotten on: only its rows are blanked and only
   *  its state rows are deleted. */
  readonly subject: string;
  /** Only this kind; every kind when omitted. */
  readonly kind?: MemoryStateKind;
  /** The forget's own rows, each `removed` with reason `forgotten`: the
   *  tombstones. Their subject, kind and hash are the forget's, and they never
   *  hold a text, whatever is passed. */
  readonly events: readonly MemoryEventRecord[];
}

export type ForgetMemoryTextResult =
  | {
      readonly applied: true;
      /** Rows whose text, previous text, reason or a detail item was blanked. */
      readonly blanked: number;
      readonly removedEntryKeys: string[];
      readonly eventIds: number[];
      /** Other subjects whose entry state or ledger still holds the text, so
       *  it can be forgotten there too. */
      readonly alsoHeldIn: string[];
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
              : { items: items.map((item) => ("text" in item ? Object.assign({}, item, { text: null }) : item)) }),
          },
        }),
  };
}

/**
 * Forget a text on one subject, in ONE statement:
 *
 * - blank it where that subject's ledger holds it (as text, previous text or a
 *   detail item whose own subject, or else the row's, is this one; of this
 *   kind when one is given). A row or item without a subject or kind is
 *   blanked too: nothing shows it belongs elsewhere;
 * - on every row about an entry whose state is deleted here (by its key),
 *   blank every text, previous text, item text and the reason, whatever text
 *   they hold: that entry's history keeps what happened, not its words;
 * - delete the entry's state rows on the subject;
 * - record the forget, whose row is the tombstone that blanks the same texts
 *   in any row appended later about something that occurred before it.
 *
 * Other subjects keep their own history; `alsoHeldIn` names those that still
 * hold the text. When one of the forget's rows is already recorded under its
 * dedupe key, nothing happens at all.
 */
export async function forgetMemoryText(
  db: Db,
  input: ForgetMemoryTextInput,
): Promise<ForgetMemoryTextResult> {
  if (input.events.length === 0) throw new Error("a forget needs at least one event");
  if (input.events.some((record) => record.event !== "removed" || record.reason !== "forgotten")) {
    throw new Error("a forget's rows are `removed` with reason `forgotten`");
  }
  requireDistinctDedupeKeys(input.events);
  const hash = sql`${input.textHash}::text`;
  const subject = sql`${canonicalMemorySubject(input.subject)}::text`;
  const kind = sql`${input.kind ?? null}::text`;
  const rowInScope = sql`coalesce(held.subject, ${subject}) = ${subject}
    AND (${kind} IS NULL OR coalesce(held.kind, ${kind}) = ${kind})`;
  const itemInScope = (item: SQL) => sql`coalesce(${item} ->> 'subject', held.subject, ${subject}) = ${subject}
    AND (${kind} IS NULL OR coalesce(${item} ->> 'kind', held.kind, ${kind}) = ${kind})`;
  const heldItems = sql`jsonb_array_elements(
    CASE WHEN jsonb_typeof(held.detail -> 'items') = 'array' THEN held.detail -> 'items' ELSE '[]'::jsonb END)`;
  const keyed = sql`coalesce(held.entry_key = ANY(forgotten_keys.keys), false)`;
  const holdsWords = sql`(held.text IS NOT NULL OR held.previous_text IS NOT NULL OR held.reason IS NOT NULL
    OR EXISTS (SELECT 1 FROM ${heldItems} AS listed(item) WHERE jsonb_typeof(listed.item -> 'text') = 'string'))`;
  const run = async () =>
    db.execute(sql`
    WITH incoming_event AS (${incomingMemoryEvents(input.events.map(withoutTexts))}),
    fresh AS (SELECT ${noneAlreadyRecorded(sql`incoming_event`)} AS ok),
    forgotten AS (
      SELECT entry_key FROM ${memoryEntryState}
      WHERE text_hash = ${hash} AND subject = ${subject} AND (${kind} IS NULL OR kind = ${kind})
    ),
    forgotten_keys AS (SELECT array_agg(entry_key) AS keys FROM forgotten),
    blanked AS (
      UPDATE ${memoryEvents} AS held SET
        text = CASE WHEN ${keyed} OR (held.text_hash = ${hash} AND ${rowInScope})
          THEN NULL ELSE held.text END,
        previous_text = CASE WHEN ${keyed} OR (held.previous_text_hash = ${hash} AND ${rowInScope})
          THEN NULL ELSE held.previous_text END,
        reason = CASE WHEN ${keyed} THEN NULL ELSE held.reason END,
        detail = CASE WHEN jsonb_typeof(held.detail -> 'items') = 'array'
          THEN jsonb_set(held.detail, '{items}', (
            SELECT coalesce(jsonb_agg(
              CASE WHEN listed.item ? 'text'
                  AND (${keyed} OR (listed.item ->> 'textHash' = ${hash} AND ${itemInScope(sql`listed.item`)}))
                THEN jsonb_set(listed.item, '{text}', 'null'::jsonb) ELSE listed.item END
              ORDER BY listed.position
            ), '[]'::jsonb)
            FROM jsonb_array_elements(held.detail -> 'items') WITH ORDINALITY AS listed(item, position)
          ))
          ELSE held.detail END,
        text_blanked_at = now()
      FROM fresh, forgotten_keys
      WHERE fresh.ok
        AND (
          (${keyed} AND ${holdsWords})
          OR (held.text_hashes @> ARRAY[${hash}] AND (
            ((held.text_hash = ${hash} OR held.previous_text_hash = ${hash}) AND ${rowInScope})
            OR EXISTS (
              SELECT 1 FROM ${heldItems} AS listed(item)
              WHERE listed.item ->> 'textHash' = ${hash} AND ${itemInScope(sql`listed.item`)}
            )
          ))
        )
      RETURNING held.id
    ),
    removed AS (
      DELETE FROM ${memoryEntryState} AS gone
      USING fresh
      WHERE fresh.ok AND gone.entry_key IN (SELECT entry_key FROM forgotten)
      RETURNING gone.entry_key
    ),
    only_removed AS (
      SELECT entry_key FROM forgotten WHERE (SELECT count(*) FROM forgotten) = 1
    ),
    also_held AS (
      SELECT state.subject FROM ${memoryEntryState} AS state
      WHERE state.text_hash = ${hash} AND state.subject <> ${subject}
      UNION
      SELECT held.subject FROM ${memoryEvents} AS held
      WHERE held.text_hashes @> ARRAY[${hash}]
        AND held.subject <> ${subject}
        AND ((held.text_hash = ${hash} AND held.text IS NOT NULL)
          OR (held.previous_text_hash = ${hash} AND held.previous_text IS NOT NULL))
      UNION
      SELECT coalesce(listed.item ->> 'subject', held.subject) FROM ${memoryEvents} AS held
      CROSS JOIN LATERAL ${heldItems} AS listed(item)
      WHERE held.text_hashes @> ARRAY[${hash}]
        AND listed.item ->> 'textHash' = ${hash}
        AND jsonb_typeof(listed.item -> 'text') = 'string'
        AND coalesce(listed.item ->> 'subject', held.subject) <> ${subject}
    ),
    appended AS (${insertMemoryEvents(sql`
      SELECT
        incoming_event.position, incoming_event.event, incoming_event.run_id, incoming_event.actor,
        incoming_event.source, incoming_event.store, ${subject} AS subject, ${kind} AS kind,
        incoming_event.entry_id,
        coalesce(incoming_event.entry_key, (SELECT entry_key FROM only_removed)) AS entry_key,
        NULL::text AS text, ${hash} AS text_hash, NULL::text AS previous_text,
        incoming_event.previous_text_hash, incoming_event.text_hashes, incoming_event.reason,
        incoming_event.ticket_key, incoming_event.pr_ref, incoming_event.invocation_key,
        incoming_event.dedupe_key, incoming_event.refers_to, incoming_event.topic, incoming_event.area,
        incoming_event.bytes, incoming_event.detail, incoming_event.occurred_at
      FROM incoming_event, fresh
      WHERE fresh.ok`)})
    SELECT
      (SELECT ok FROM fresh) AS fresh,
      (SELECT count(*)::int FROM blanked) AS blanked,
      (SELECT json_agg(entry_key::text) FROM removed) AS removed_entry_keys,
      (SELECT json_agg(id ORDER BY id) FROM appended) AS event_ids,
      (SELECT json_agg(subject ORDER BY subject) FROM also_held WHERE subject IS NOT NULL) AS also_held_in
  `);
  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await run();
  } catch (error) {
    if (isDedupeRace(error)) return { applied: false, why: "duplicate" };
    throw error;
  }
  const row = rawRows<{
    fresh: boolean;
    blanked: number;
    removed_entry_keys: string[] | null;
    event_ids: Array<number | string> | null;
    also_held_in: string[] | null;
  }>(result)[0];
  if (!row) throw new Error("memory forget returned no row");
  if (!row.fresh) return { applied: false, why: "duplicate" };
  return {
    applied: true,
    blanked: Number(row.blanked),
    removedEntryKeys: row.removed_entry_keys ?? [],
    eventIds: (row.event_ids ?? []).map(Number),
    alsoHeldIn: row.also_held_in ?? [],
  };
}

function rawRows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}
