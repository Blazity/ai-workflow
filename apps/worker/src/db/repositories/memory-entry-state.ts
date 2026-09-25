import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { getDb, type Db } from "../client.js";
import { memoryEntryState } from "../memory-entry-state-schema.js";
import { storable } from "../memory-storable.js";
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
  canonicalMemorySubject,
  earliestOccurrence,
  forgetMemoryText,
  forgottenAfter,
  incomingMemoryEvents,
  insertMemoryEvents,
  isDedupeRace,
  listMemoryEventHistory,
  listPendingMemoryProposals,
  listRunMemoryEvents,
  noneAlreadyRecorded,
  requireDistinctDedupeKeys,
  searchMemoryEvents,
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
 *
 * Two writers that change one entry at once both land: an added dispute and
 * a relearned count are applied to the row as it is when the write reaches
 * it, never to the copy the caller read. A write about a text forgotten on
 * the subject after its events occurred is refused (`forgotten`).
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
 * `addOpenDisputes` appends to the disputes as stored when the write lands
 * (after `openDisputes`, when both are given), skipping a run that already
 * has one open; `addRelearnedUnseen` adds to the count the same way.
 */
export type MemoryEntryStateChange = Partial<Omit<MemoryEntryStateValues, "storeIds">> & {
  readonly storeIds?: Readonly<Record<string, string | null>>;
  readonly addOpenDisputes?: readonly MemoryOpenDispute[];
  readonly addRelearnedUnseen?: number;
};

export type StoredMemoryEntryState = typeof memoryEntryState.$inferSelect;

/** A store id offered for an entry whose state already holds another id for
 *  that store: the stored one is kept, and the write says so. */
interface MemoryStoreIdConflict {
  readonly store: string;
  readonly kept: string;
  readonly offered: string;
}

/**
 * `applied: false` wrote nothing at all:
 * - `duplicate`: an event of this write is already recorded under its
 *   (run, dedupe key), so this write already happened;
 * - `version_mismatch`: the stored version is not the one the caller read
 *   (0 means the caller read no row);
 * - `not_found`: no entry has that key or alias;
 * - `alias_taken`: another entry already answers to the text moved to;
 * - `forgotten`: the text was forgotten on this subject after the write's
 *   events occurred, so the write is about an entry that no longer exists.
 */
export type MemoryEntryStateWrite =
  | {
      readonly applied: true;
      readonly entryKey: string;
      readonly version: number;
      readonly eventIds: number[];
      readonly storeIdConflicts?: readonly MemoryStoreIdConflict[];
    }
  | {
      readonly applied: false;
      readonly why: "duplicate" | "version_mismatch" | "not_found" | "alias_taken" | "forgotten";
      readonly storedVersion: number | null;
    };

export interface RecordMemoryEntryStateInput {
  readonly alias: MemoryEntryAlias;
  /** The whole row, used when no entry answers to the alias yet. When one
   *  does, only its `storeIds` are used, for stores the entry has no id for. */
  readonly create: MemoryEntryStateValues;
  /** What to set when an entry already answers to the alias; over `create`
   *  when none does. */
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

/** One open dispute per run: the first given is kept. */
function oneDisputePerRun(disputes: readonly MemoryOpenDispute[]): MemoryOpenDispute[] {
  const seen = new Set<string>();
  return disputes.filter((dispute) => !seen.has(dispute.runId) && seen.add(dispute.runId) !== undefined);
}

/** `base` with every added dispute whose run has none open in it, in order. */
function withAddedDisputes(base: SQL, added: readonly MemoryOpenDispute[]): SQL {
  return sql`(
    SELECT ${base} || coalesce(jsonb_agg(added.dispute ORDER BY added.position), '[]'::jsonb)
    FROM jsonb_array_elements(${jsonText(oneDisputePerRun(added))}::jsonb) WITH ORDINALITY AS added(dispute, position)
    WHERE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(${base}) AS held(dispute)
      WHERE held.dispute ->> 'runId' = added.dispute ->> 'runId'
    )
  )`;
}

/**
 * The SET list of a change, against the row aliased `existing`. `fillStoreIds`
 * are ids for stores the row has none for; they never replace a stored one.
 */
function assignments(
  input: MemoryEntryStateChange | undefined,
  fillStoreIds: Readonly<Record<string, string>> = {},
): SQL[] {
  const change = storable(input ?? {});
  const set: SQL[] = [];
  const text = (column: string, value: string | null | undefined) => {
    if (value !== undefined) set.push(sql`${sql.raw(column)} = ${value}::text`);
  };
  if (change.storeIds !== undefined || Object.keys(fillStoreIds).length > 0) {
    set.push(sql`store_ids = jsonb_strip_nulls(
      ${jsonText(storable(fillStoreIds))}::jsonb || existing.store_ids || ${jsonText(change.storeIds ?? {})}::jsonb)`);
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
    // The time a status began, so it moves only when the status does.
    set.push(
      sql`status = ${change.status}::text`,
      sql`status_since = CASE WHEN existing.status IS DISTINCT FROM ${change.status}::text
      THEN now() ELSE existing.status_since END`,
    );
  }
  text("status_reason", change.statusReason);
  if (change.openDisputes !== undefined || change.addOpenDisputes !== undefined) {
    const base =
      change.openDisputes === undefined
        ? sql`existing.open_disputes`
        : sql`${jsonText(change.openDisputes)}::jsonb`;
    set.push(
      sql`open_disputes = ${change.addOpenDisputes === undefined ? base : withAddedDisputes(base, change.addOpenDisputes)}`,
    );
  }
  if (change.relearnedUnseen !== undefined || change.addRelearnedUnseen !== undefined) {
    const base =
      change.relearnedUnseen === undefined
        ? sql`existing.relearned_unseen`
        : sql`${change.relearnedUnseen}::integer`;
    set.push(sql`relearned_unseen = ${base} + ${change.addRelearnedUnseen ?? 0}::integer`);
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
 * statement on the unique index (read back as `duplicate`) rather than
 * landing a change without its event.
 */
const appendedFromChanged = sql`
  appended AS (${insertMemoryEvents(sql`
    SELECT
      incoming_event.position, incoming_event.event, incoming_event.run_id, incoming_event.actor,
      incoming_event.source, incoming_event.store,
      coalesce(incoming_event.subject, changed.subject) AS subject,
      coalesce(incoming_event.kind, changed.kind) AS kind, incoming_event.entry_id,
      coalesce(incoming_event.entry_key, changed.entry_key) AS entry_key, incoming_event.text,
      coalesce(incoming_event.text_hash, changed.text_hash) AS text_hash, incoming_event.previous_text,
      incoming_event.previous_text_hash, incoming_event.text_hashes, incoming_event.reason,
      incoming_event.ticket_key, incoming_event.pr_ref, incoming_event.invocation_key,
      incoming_event.dedupe_key, incoming_event.refers_to, incoming_event.topic,
      incoming_event.area, incoming_event.bytes, incoming_event.detail, incoming_event.occurred_at
    FROM incoming_event CROSS JOIN changed`)})`;

interface WriteRow {
  fresh: boolean;
  forgotten: boolean;
  found: boolean;
  taken: boolean;
  stored_version: number | null;
  entry_key: string | null;
  version: number | null;
  event_ids: Array<number | string> | null;
}

function outcome(row: WriteRow | undefined, storeIdConflicts: readonly MemoryStoreIdConflict[] = []): MemoryEntryStateWrite {
  if (!row) throw new Error("memory entry state write returned no row");
  const storedVersion = row.stored_version === null ? null : Number(row.stored_version);
  if (row.entry_key !== null && row.version !== null) {
    return {
      applied: true,
      entryKey: row.entry_key,
      version: Number(row.version),
      eventIds: (row.event_ids ?? []).map(Number),
      ...(storeIdConflicts.length === 0 ? {} : { storeIdConflicts }),
    };
  }
  if (!row.fresh) return { applied: false, why: "duplicate", storedVersion };
  if (row.forgotten) return { applied: false, why: "forgotten", storedVersion };
  if (!row.found) return { applied: false, why: "not_found", storedVersion };
  if (row.taken) return { applied: false, why: "alias_taken", storedVersion };
  return { applied: false, why: "version_mismatch", storedVersion };
}

function requireEvents(events: readonly MemoryEventRecord[]) {
  if (events.length === 0) throw new Error("a memory entry state change needs at least one event");
  requireDistinctDedupeKeys(events);
}

/** Runs a state write; a race another write won on a dedupe key is that
 *  write's duplicate, not a failure. */
async function executeWrite(
  db: Db,
  statement: SQL,
): Promise<{ readonly raced: true } | { readonly raced: false; readonly row: WriteRow | undefined }> {
  try {
    return { raced: false, row: rawRows<WriteRow>(await db.execute(statement))[0] };
  } catch (error) {
    if (isDedupeRace(error)) return { raced: true };
    throw error;
  }
}

const RACED: MemoryEntryStateWrite = { applied: false, why: "duplicate", storedVersion: null };

/** The ids offered on create that a stored entry already holds another id for. */
function findStoreIdConflicts(
  stored: Readonly<Record<string, string>> | null,
  offered: Readonly<Record<string, string>>,
): MemoryStoreIdConflict[] {
  if (stored === null) return [];
  return Object.entries(offered).flatMap(([store, id]) => {
    const kept = stored[store];
    return kept !== undefined && kept !== id ? [{ store, kept, offered: id }] : [];
  });
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
  const { kind, textHash } = input.alias;
  const subject = canonicalMemorySubject(input.alias.subject);
  const { addOpenDisputes, addRelearnedUnseen, ...changed } = input.change ?? {};
  const values = storable({
    ...input.create,
    ...changed,
    openDisputes: oneDisputePerRun([
      ...(changed.openDisputes ?? input.create.openDisputes),
      ...(addOpenDisputes ?? []),
    ]),
    relearnedUnseen: (changed.relearnedUnseen ?? input.create.relearnedUnseen) + (addRelearnedUnseen ?? 0),
  });
  const storeIds = Object.fromEntries(
    Object.entries({ ...input.create.storeIds, ...input.change?.storeIds }).filter(
      ([, id]) => id !== null,
    ),
  );
  // Ids the change does not name: they fill a store the entry has no id for,
  // and never replace one it has.
  const offered = Object.fromEntries(
    Object.entries(input.create.storeIds).filter(([store]) => input.change?.storeIds?.[store] === undefined),
  );
  const written = await executeWrite(db, sql`
    WITH incoming_event AS (${incomingMemoryEvents(input.events)}),
    fresh AS (SELECT ${noneAlreadyRecorded(sql`incoming_event`)} AS ok),
    covered AS (
      SELECT ${forgottenAfter(sql`${subject}::text`, sql`${kind}::text`, sql`${textHash}::text`, earliestOccurrence(sql`incoming_event`))} AS forgotten
    ),
    stored AS (
      SELECT version, store_ids FROM ${memoryEntryState}
      WHERE subject = ${subject}::text AND kind = ${kind}::text AND text_hash = ${textHash}::text
    ),
    changed AS (
      INSERT INTO ${memoryEntryState} AS existing (
        subject, kind, text_hash, store_ids, topic, area, area_status, area_candidates, module,
        anchors, trust, pinned, status, status_reason, open_disputes, relearned_unseen,
        origin_run_id, origin_ticket, last_admitted_at
      )
      SELECT
        ${subject}::text, ${kind}::text, ${textHash}::text, ${jsonText(storable(storeIds))}::jsonb,
        ${values.topic}::text, ${values.area}::text, ${values.areaStatus}::text,
        ${textArray(values.areaCandidates)}, ${values.module}::text, ${textArray(values.anchors)},
        ${values.trust}::text, ${values.pinned}::boolean, ${values.status}::text,
        ${values.statusReason}::text, ${jsonText(values.openDisputes)}::jsonb,
        ${values.relearnedUnseen}::integer, ${values.originRunId}::text,
        ${values.originTicket}::text, ${instant(values.lastAdmittedAt)}
      FROM fresh, covered
      WHERE fresh.ok
        AND NOT covered.forgotten
        AND (${expected(input.expectedVersion)} IS NULL
          OR ${expected(input.expectedVersion)} = coalesce((SELECT version FROM stored), 0))
      ON CONFLICT (subject, kind, text_hash) DO UPDATE SET ${sql.join(assignments(input.change, offered), sql`, `)}
        WHERE ${expected(input.expectedVersion)} IS NULL
          OR existing.version = ${expected(input.expectedVersion)}
      RETURNING existing.entry_key, existing.subject, existing.kind, existing.text_hash, existing.version
    ),
    ${appendedFromChanged}
    SELECT
      (SELECT ok FROM fresh) AS fresh,
      (SELECT forgotten FROM covered) AS forgotten,
      true AS found,
      false AS taken,
      (SELECT version FROM stored) AS stored_version,
      (SELECT store_ids FROM stored) AS stored_store_ids,
      (SELECT entry_key::text FROM changed) AS entry_key,
      (SELECT version FROM changed) AS version,
      (SELECT json_agg(id ORDER BY id) FROM appended) AS event_ids
  `);
  if (written.raced) return RACED;
  const row = written.row as (WriteRow & { stored_store_ids: Record<string, string> | null }) | undefined;
  return outcome(row, findStoreIdConflicts(row?.stored_store_ids ?? null, offered));
}

function targetCondition(target: MemoryEntryTarget): SQL {
  return "entryKey" in target
    ? sql`entry_key = ${target.entryKey}::uuid`
    : sql`subject = ${canonicalMemorySubject(target.alias.subject)}::text AND kind = ${target.alias.kind}::text
        AND text_hash = ${target.alias.textHash}::text`;
}

/**
 * Change an entry that has a state, by its key or its current alias, together
 * with its events; `moveTo` moves the alias to the entry's new text and keeps
 * the key, the trust and the pin, unless that text was forgotten on the
 * subject after the events occurred.
 */
export async function changeMemoryEntryState(
  db: Db,
  input: ChangeMemoryEntryStateInput,
): Promise<MemoryEntryStateWrite> {
  requireEvents(input.events);
  const moveTo = input.moveTo ?? null;
  const set = assignments(input.change);
  if (moveTo !== null) set.push(sql`text_hash = ${moveTo}::text`);
  const written = await executeWrite(db, sql`
    WITH incoming_event AS (${incomingMemoryEvents(input.events)}),
    fresh AS (SELECT ${noneAlreadyRecorded(sql`incoming_event`)} AS ok),
    target AS (
      SELECT entry_key, subject, kind, version FROM ${memoryEntryState}
      WHERE ${targetCondition(input.target)}
    ),
    covered AS (
      SELECT coalesce(bool_or(${moveTo === null ? sql`false` : forgottenAfter(sql`target.subject`, sql`target.kind`, sql`${moveTo}::text`, earliestOccurrence(sql`incoming_event`))}), false) AS forgotten
      FROM target
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
      FROM fresh, taken, target, covered
      WHERE existing.entry_key = target.entry_key
        AND fresh.ok
        AND NOT covered.forgotten
        AND NOT taken.taken
        AND (${expected(input.expectedVersion)} IS NULL
          OR existing.version = ${expected(input.expectedVersion)})
      RETURNING existing.entry_key, existing.subject, existing.kind, existing.text_hash, existing.version
    ),
    ${appendedFromChanged}
    SELECT
      (SELECT ok FROM fresh) AS fresh,
      (SELECT forgotten FROM covered) AS forgotten,
      EXISTS (SELECT 1 FROM target) AS found,
      (SELECT taken FROM taken) AS taken,
      (SELECT version FROM target) AS stored_version,
      (SELECT entry_key::text FROM changed) AS entry_key,
      (SELECT version FROM changed) AS version,
      (SELECT json_agg(id ORDER BY id) FROM appended) AS event_ids
  `);
  return written.raced ? RACED : outcome(written.row);
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
            eq(memoryEntryState.subject, canonicalMemorySubject(target.alias.subject)),
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
        eq(memoryEntryState.subject, canonicalMemorySubject(query.subject)),
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
