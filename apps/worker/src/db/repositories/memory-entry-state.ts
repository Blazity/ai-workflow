import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { getDb, type Db } from "../client.js";
import { memoryEntryState } from "../memory-entry-state-schema.js";
import { memoryEvents } from "../memory-events-schema.js";
import type {
  MemoryAreaStatus,
  MemoryEntryStatus,
  MemoryOpenDispute,
  MemoryStateKind,
  MemoryTopic,
  MemoryTrust,
} from "../memory-vocabulary.js";
import {
  appendMemoryEvents,
  forgetMemoryText,
  incomingMemoryEvents,
  listMemoryEventHistory,
  listPendingMemoryProposals,
  listRunMemoryEvents,
  MEMORY_EVENT_INSERT_COLUMNS,
  noneAlreadyRecorded,
  searchMemoryEvents,
  withoutNul,
  type AppendMemoryEventsResult,
  type ForgetMemoryTextInput,
  type ForgetMemoryTextResult,
  type MemoryEventHistoryQuery,
  type MemoryEventPage,
  type MemoryEventRecord,
  type StoredMemoryEvent,
} from "./memory-events.js";

/**
 * Every memory entry's place and trust, written together with the ledger rows
 * that say why, in ONE statement: production runs neon-http, which cannot
 * open a transaction (`db/client.ts`), and a state nobody can explain, or an
 * event about a change that did not happen, is a record that lies.
 *
 * So each write here is all or nothing: the state change and every event it
 * carries land, or none of them does. An event whose (run, dedupe key) is
 * already recorded makes the whole write a duplicate, which is what makes a
 * retried step safe. Callers go through `memory/ledger`.
 */

/** The current alias an entry answers to. */
interface MemoryEntryAlias {
  readonly subject: string;
  readonly kind: MemoryStateKind;
  readonly textHash: string;
}

export type MemoryEntryTarget = { readonly entryKey: string } | { readonly alias: MemoryEntryAlias };

/** Every value of a state row a writer chooses. */
export interface MemoryEntryStateValues {
  readonly storeIds: Readonly<Record<string, string>>;
  readonly topic: MemoryTopic;
  readonly area: string;
  readonly areaStatus: MemoryAreaStatus;
  readonly areaCandidates: readonly string[];
  readonly module: string | null;
  readonly anchors: readonly string[];
  readonly trust: MemoryTrust;
  readonly pinned: boolean;
  readonly status: MemoryEntryStatus;
  readonly statusReason: string | null;
  readonly openDisputes: readonly MemoryOpenDispute[];
  readonly relearnedUnseen: number;
  readonly originRunId: string | null;
  readonly originTicket: string | null;
  readonly lastAdmittedAt: Date | null;
}

/**
 * The fields a change sets; the rest keep their value. `storeIds` is merged
 * into the stored ids by store, and a store set to null is dropped from them.
 */
export type MemoryEntryStateChange = Partial<Omit<MemoryEntryStateValues, "storeIds">> & {
  readonly storeIds?: Readonly<Record<string, string | null>>;
};

export type StoredMemoryEntryState = typeof memoryEntryState.$inferSelect;

/**
 * `applied: false` wrote nothing at all:
 * - `duplicate`: an event of this write is already recorded under its
 *   (run, dedupe key), so this write already happened;
 * - `version_mismatch`: the stored version is not the one the caller read
 *   (0 means the caller read no row);
 * - `not_found`: no entry has that key or alias;
 * - `alias_taken`: another entry already answers to the text moved to.
 */
export type MemoryEntryStateWrite =
  | { readonly applied: true; readonly entryKey: string; readonly version: number; readonly eventIds: number[] }
  | {
      readonly applied: false;
      readonly why: "duplicate" | "version_mismatch" | "not_found" | "alias_taken";
      readonly storedVersion: number | null;
    };

export interface RecordMemoryEntryStateInput {
  readonly alias: MemoryEntryAlias;
  /** The whole row, used when no entry answers to the alias yet. */
  readonly create: MemoryEntryStateValues;
  /** What to set when an entry already answers to the alias. */
  readonly change?: MemoryEntryStateChange;
  /** The version the caller read, 0 for "I read no row"; omit to write blind. */
  readonly expectedVersion?: number;
  /** At least one: a state change is never written without its reason. */
  readonly events: readonly MemoryEventRecord[];
}

export interface ChangeMemoryEntryStateInput {
  readonly target: MemoryEntryTarget;
  readonly change?: MemoryEntryStateChange;
  /** The hash of the entry's new text: the alias moves, the key stays. */
  readonly moveTo?: string;
  readonly expectedVersion?: number;
  readonly events: readonly MemoryEventRecord[];
}

const jsonText = (value: unknown) => JSON.stringify(value);
const textArray = (values: readonly string[]) =>
  sql`ARRAY(SELECT jsonb_array_elements_text(${jsonText(values)}::jsonb))`;
const instant = (value: Date | null) => sql`${value === null ? null : value.toISOString()}::timestamptz`;

/** The SET list of a change, against the row aliased `existing`. */
function assignments(input: MemoryEntryStateChange | undefined): SQL[] {
  const change = withoutNul(input ?? {});
  const set: SQL[] = [];
  const text = (column: string, value: string | null | undefined) => {
    if (value !== undefined) set.push(sql`${sql.raw(column)} = ${value}::text`);
  };
  if (change.storeIds !== undefined) {
    set.push(sql`store_ids = jsonb_strip_nulls(existing.store_ids || ${jsonText(change.storeIds)}::jsonb)`);
  }
  text("topic", change.topic);
  text("area", change.area);
  text("area_status", change.areaStatus);
  if (change.areaCandidates !== undefined) {
    set.push(sql`area_candidates = ${textArray(change.areaCandidates)}`);
  }
  text("module", change.module);
  if (change.anchors !== undefined) set.push(sql`anchors = ${textArray(change.anchors)}`);
  text("trust", change.trust);
  if (change.pinned !== undefined) set.push(sql`pinned = ${change.pinned}::boolean`);
  if (change.status !== undefined) {
    set.push(sql`status = ${change.status}::text`);
    // The time a status began, so it moves only when the status does.
    set.push(sql`status_since = CASE WHEN existing.status IS DISTINCT FROM ${change.status}::text
      THEN now() ELSE existing.status_since END`);
  }
  text("status_reason", change.statusReason);
  if (change.openDisputes !== undefined) {
    set.push(sql`open_disputes = ${jsonText(change.openDisputes)}::jsonb`);
  }
  if (change.relearnedUnseen !== undefined) {
    set.push(sql`relearned_unseen = ${change.relearnedUnseen}::integer`);
  }
  text("origin_run_id", change.originRunId);
  text("origin_ticket", change.originTicket);
  if (change.lastAdmittedAt !== undefined) set.push(sql`last_admitted_at = ${instant(change.lastAdmittedAt)}`);
  set.push(sql`version = existing.version + 1`, sql`updated_at = now()`);
  return set;
}

/**
 * The events of a state write, inserted from the row the write returned
 * (`changed`), so each carries the entry's key, and its subject, kind and
 * alias unless the event names its own. No `ON CONFLICT`: a duplicate is
 * refused up front by `fresh`, and one that races past it fails the whole
 * statement on the unique index rather than landing a change without its
 * event.
 */
const appendedFromChanged = sql`
  appended AS (
    INSERT INTO ${memoryEvents} ${MEMORY_EVENT_INSERT_COLUMNS}
    SELECT
      incoming_event.event, incoming_event.run_id, incoming_event.actor, incoming_event.source,
      incoming_event.store, coalesce(incoming_event.subject, changed.subject),
      coalesce(incoming_event.kind, changed.kind), incoming_event.entry_id,
      coalesce(incoming_event.entry_key, changed.entry_key), incoming_event.text,
      coalesce(incoming_event.text_hash, changed.text_hash), incoming_event.previous_text,
      incoming_event.previous_text_hash, incoming_event.text_hashes, incoming_event.reason,
      incoming_event.ticket_key, incoming_event.pr_ref, incoming_event.invocation_key,
      incoming_event.dedupe_key, incoming_event.refers_to, incoming_event.topic,
      incoming_event.area, incoming_event.bytes, incoming_event.detail
    FROM incoming_event CROSS JOIN changed
    ORDER BY incoming_event.position
    RETURNING id
  )`;

interface WriteRow {
  fresh: boolean;
  found: boolean;
  taken: boolean;
  stored_version: number | null;
  entry_key: string | null;
  version: number | null;
  event_ids: Array<number | string> | null;
}

function outcome(row: WriteRow | undefined): MemoryEntryStateWrite {
  if (!row) throw new Error("memory entry state write returned no row");
  const storedVersion = row.stored_version === null ? null : Number(row.stored_version);
  if (row.entry_key !== null && row.version !== null) {
    return {
      applied: true,
      entryKey: row.entry_key,
      version: Number(row.version),
      eventIds: (row.event_ids ?? []).map(Number),
    };
  }
  if (!row.fresh) return { applied: false, why: "duplicate", storedVersion };
  if (!row.found) return { applied: false, why: "not_found", storedVersion };
  if (row.taken) return { applied: false, why: "alias_taken", storedVersion };
  return { applied: false, why: "version_mismatch", storedVersion };
}

function requireEvents(events: readonly MemoryEventRecord[]) {
  if (events.length === 0) throw new Error("a memory entry state change needs at least one event");
}

const expected = (value: number | undefined) => sql`${value ?? null}::integer`;

/**
 * Create an entry's state under its alias, or change the entry that already
 * answers to it, together with its events. With `expectedVersion: 0` it only
 * creates.
 */
export async function recordMemoryEntryState(
  db: Db,
  input: RecordMemoryEntryStateInput,
): Promise<MemoryEntryStateWrite> {
  requireEvents(input.events);
  const { subject, kind, textHash } = input.alias;
  const values = withoutNul({ ...input.create, ...input.change });
  const storeIds = Object.fromEntries(
    Object.entries({ ...input.create.storeIds, ...input.change?.storeIds }).filter(
      ([, id]) => id !== null,
    ),
  );
  const result = await db.execute(sql`
    WITH incoming_event AS (${incomingMemoryEvents(input.events)}),
    fresh AS (SELECT ${noneAlreadyRecorded(sql`incoming_event`)} AS ok),
    stored AS (
      SELECT version FROM ${memoryEntryState}
      WHERE subject = ${subject}::text AND kind = ${kind}::text AND text_hash = ${textHash}::text
    ),
    changed AS (
      INSERT INTO ${memoryEntryState} AS existing (
        subject, kind, text_hash, store_ids, topic, area, area_status, area_candidates, module,
        anchors, trust, pinned, status, status_reason, open_disputes, relearned_unseen,
        origin_run_id, origin_ticket, last_admitted_at
      )
      SELECT
        ${subject}::text, ${kind}::text, ${textHash}::text, ${jsonText(storeIds)}::jsonb,
        ${values.topic}::text, ${values.area}::text, ${values.areaStatus}::text,
        ${textArray(values.areaCandidates)}, ${values.module}::text, ${textArray(values.anchors)},
        ${values.trust}::text, ${values.pinned}::boolean, ${values.status}::text,
        ${values.statusReason}::text, ${jsonText(values.openDisputes)}::jsonb,
        ${values.relearnedUnseen}::integer, ${values.originRunId}::text,
        ${values.originTicket}::text, ${instant(values.lastAdmittedAt)}
      FROM fresh
      WHERE fresh.ok
        AND (${expected(input.expectedVersion)} IS NULL
          OR ${expected(input.expectedVersion)} = coalesce((SELECT version FROM stored), 0))
      ON CONFLICT (subject, kind, text_hash) DO UPDATE SET ${sql.join(assignments(input.change), sql`, `)}
        WHERE ${expected(input.expectedVersion)} IS NULL
          OR existing.version = ${expected(input.expectedVersion)}
      RETURNING existing.entry_key, existing.subject, existing.kind, existing.text_hash, existing.version
    ),
    ${appendedFromChanged}
    SELECT
      (SELECT ok FROM fresh) AS fresh,
      true AS found,
      false AS taken,
      (SELECT version FROM stored) AS stored_version,
      (SELECT entry_key::text FROM changed) AS entry_key,
      (SELECT version FROM changed) AS version,
      (SELECT json_agg(id ORDER BY id) FROM appended) AS event_ids
  `);
  return outcome(rawRows<WriteRow>(result)[0]);
}

function targetCondition(target: MemoryEntryTarget): SQL {
  return "entryKey" in target
    ? sql`entry_key = ${target.entryKey}::uuid`
    : sql`subject = ${target.alias.subject}::text AND kind = ${target.alias.kind}::text
        AND text_hash = ${target.alias.textHash}::text`;
}

/**
 * Change an entry that has a state, by its key or its current alias, together
 * with its events; `moveTo` moves the alias to the entry's new text and keeps
 * the key, the trust and the pin.
 */
export async function changeMemoryEntryState(
  db: Db,
  input: ChangeMemoryEntryStateInput,
): Promise<MemoryEntryStateWrite> {
  requireEvents(input.events);
  const moveTo = input.moveTo ?? null;
  const set = assignments(input.change);
  if (moveTo !== null) set.push(sql`text_hash = ${moveTo}::text`);
  const result = await db.execute(sql`
    WITH incoming_event AS (${incomingMemoryEvents(input.events)}),
    fresh AS (SELECT ${noneAlreadyRecorded(sql`incoming_event`)} AS ok),
    target AS (
      SELECT entry_key, subject, kind, version FROM ${memoryEntryState}
      WHERE ${targetCondition(input.target)}
    ),
    taken AS (
      SELECT EXISTS (
        SELECT 1
        FROM ${memoryEntryState} AS other
        JOIN target ON other.subject = target.subject AND other.kind = target.kind
        WHERE other.text_hash = ${moveTo}::text AND other.entry_key <> target.entry_key
      ) AS taken
    ),
    changed AS (
      UPDATE ${memoryEntryState} AS existing SET ${sql.join(set, sql`, `)}
      FROM fresh, taken, target
      WHERE existing.entry_key = target.entry_key
        AND fresh.ok
        AND NOT taken.taken
        AND (${expected(input.expectedVersion)} IS NULL
          OR existing.version = ${expected(input.expectedVersion)})
      RETURNING existing.entry_key, existing.subject, existing.kind, existing.text_hash, existing.version
    ),
    ${appendedFromChanged}
    SELECT
      (SELECT ok FROM fresh) AS fresh,
      EXISTS (SELECT 1 FROM target) AS found,
      (SELECT taken FROM taken) AS taken,
      (SELECT version FROM target) AS stored_version,
      (SELECT entry_key::text FROM changed) AS entry_key,
      (SELECT version FROM changed) AS version,
      (SELECT json_agg(id ORDER BY id) FROM appended) AS event_ids
  `);
  return outcome(rawRows<WriteRow>(result)[0]);
}

/** One entry's state, or null when it has none: the core reads a missing
 *  row as the defaults. */
export async function getMemoryEntryState(
  db: Db,
  target: MemoryEntryTarget,
): Promise<StoredMemoryEntryState | null> {
  const [row] = await db
    .select()
    .from(memoryEntryState)
    .where(
      "entryKey" in target
        ? eq(memoryEntryState.entryKey, target.entryKey)
        : and(
            eq(memoryEntryState.subject, target.alias.subject),
            eq(memoryEntryState.kind, target.alias.kind),
            eq(memoryEntryState.textHash, target.alias.textHash),
          ),
    )
    .limit(1);
  return row ?? null;
}

/** Every entry state of a subject, optionally of one kind. */
export async function listMemoryEntryStates(
  db: Db,
  query: { subject: string; kind?: MemoryStateKind },
): Promise<StoredMemoryEntryState[]> {
  return db
    .select()
    .from(memoryEntryState)
    .where(
      and(
        eq(memoryEntryState.subject, query.subject),
        query.kind === undefined ? undefined : eq(memoryEntryState.kind, query.kind),
      ),
    )
    .orderBy(asc(memoryEntryState.kind), asc(memoryEntryState.createdAt), asc(memoryEntryState.entryKey));
}

/**
 * The ledger and the entry state bound to one database: the only way the
 * memory module reaches either, so it never touches the database client. A
 * test binds it to pglite, production to the connected database.
 */
export interface MemoryLedgerRepository {
  appendEvents(records: readonly MemoryEventRecord[]): Promise<AppendMemoryEventsResult>;
  recordEntryState(input: RecordMemoryEntryStateInput): Promise<MemoryEntryStateWrite>;
  changeEntryState(input: ChangeMemoryEntryStateInput): Promise<MemoryEntryStateWrite>;
  forgetText(input: ForgetMemoryTextInput): Promise<ForgetMemoryTextResult>;
  runEvents(runId: string, options?: { after?: number; limit?: number }): Promise<MemoryEventPage>;
  history(query: MemoryEventHistoryQuery): Promise<MemoryEventPage>;
  search(query: { contains: string; subject?: string; before?: number; limit?: number }): Promise<MemoryEventPage>;
  pendingProposals(prRef: string): Promise<StoredMemoryEvent[]>;
  entryState(target: MemoryEntryTarget): Promise<StoredMemoryEntryState | null>;
  entryStates(query: { subject: string; kind?: MemoryStateKind }): Promise<StoredMemoryEntryState[]>;
}

export function memoryLedgerRepository(db: Db): MemoryLedgerRepository {
  return {
    appendEvents: (records) => appendMemoryEvents(db, records),
    recordEntryState: (input) => recordMemoryEntryState(db, input),
    changeEntryState: (input) => changeMemoryEntryState(db, input),
    forgetText: (input) => forgetMemoryText(db, input),
    runEvents: (runId, options) => listRunMemoryEvents(db, runId, options),
    history: (query) => listMemoryEventHistory(db, query),
    search: (query) => searchMemoryEvents(db, query),
    pendingProposals: (prRef) => listPendingMemoryProposals(db, prRef),
    entryState: (target) => getMemoryEntryState(db, target),
    entryStates: (query) => listMemoryEntryStates(db, query),
  };
}

/** The repository on the production database, connected on first use. */
export function connectedMemoryLedgerRepository(): MemoryLedgerRepository {
  return memoryLedgerRepository(getDb());
}

function rawRows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}
