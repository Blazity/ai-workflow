/**
 * Storage for agent visibility: briefings with their shared texts, the durable
 * per-run capture facts, and the answer deliveries of a clarification.
 *
 * EVERY WRITE IS ONE STATEMENT. Production runs neon-http, which cannot open a
 * transaction (`db/client.ts`), so a briefing and the texts it points at are
 * inserted together as one data-modifying CTE, and a delivery is merged into
 * the latest row or appended by one statement whose unique chain decides the
 * race. The pglite driver used in tests does support transactions and would
 * not catch a violation: grep this file for `transaction(`.
 *
 * This tier may not import `@shared/agent-visibility` (ADR-001 lets the db
 * tier see `@shared/contracts` only), so the index travels as JSON and the
 * vocabularies travel as strings the service layer types.
 */
import { sql } from "drizzle-orm";
import { getDb } from "../client.js";
import type { Db } from "../types.js";

/** How long a briefing is kept when its run has no replay expiry of its own,
 *  the same thirty days the replay observations get. */
const BRIEFING_RETENTION_DAYS = 30;

/**
 * How long a text a capture has just pointed at is left alone by the sweep.
 *
 * `INSERT ... ON CONFLICT DO NOTHING` takes no lock a sweep could wait on, so
 * a capture bumps `last_referenced_at` on every text it points at instead: a
 * DELETE that read the old row then has to re-evaluate the updated one and
 * leaves it. Longer than any statement can take, shorter than anything a
 * person waits for.
 */
const TEXT_SWEEP_GRACE_MINUTES = 60;

const DEFAULT_BRIEFING_CLEANUP_LIMIT = 200;

function rawRows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

type AgentBriefingCapture = "captured" | "capture_disabled" | "capture_skipped";
type AgentBriefingKindName = "discovery" | "agent" | "llm";

export interface AgentBriefingIdentityRow {
  runId: string;
  nodeId: string;
  attempt: number;
  activationScopeId: string;
  sequence: number;
}

interface AgentBriefingTextRow {
  sha256: string;
  text: string;
  bytes: number;
}

export interface RecordAgentBriefingRowInput extends AgentBriefingIdentityRow {
  kind: AgentBriefingKindName;
  capture: AgentBriefingCapture;
  /** The package's index, or null on a marker row. */
  index: unknown;
  /** The sha256 of the stored index without its capture time, or null on a
   *  marker row. */
  contentSha256: string | null;
  /** Each stored text once, in first-use order; empty on a marker row. */
  texts: readonly AgentBriefingTextRow[];
  /** The index and its texts in UTF-8 bytes. */
  bytes: number;
  /** Why a send was not recorded; already redacted by the caller. */
  detail: string | null;
  capturedAt: Date;
}

export type RecordAgentBriefingRowResult =
  | { outcome: "recorded"; briefingId: number }
  /** The same send, written again by a replay or a retry: one row, unchanged. */
  | { outcome: "already_recorded"; briefingId: number | null }
  /** A DIFFERENT briefing under the same identity and sequence. The stored one
   *  is left alone and the caller says so out loud: two sends numbered the
   *  same would otherwise make one of them invisible for good. */
  | {
      outcome: "conflict";
      briefingId: number;
      stored: { kind: string; capture: string; contentSha256: string | null };
    };

interface RecordedRow {
  outcome: "inserted" | "exists";
  id: number;
  kind: string;
  capture: string;
  content_sha256: string | null;
}

/**
 * One statement: the briefing and the texts it points at.
 *
 * The texts are written only where the briefing was, so a second send under an
 * identity that already holds a different briefing leaves no text behind that
 * nothing points at. The run's durable facts are a second statement
 * (`recordAgentBriefingRunFact`), because they have to be written on the
 * outcomes where this one writes nothing at all.
 *
 * `expires_at` is the LATER of the run's replay expiry and thirty days from
 * the send: a briefing captured by a run whose replay has already expired
 * would otherwise be born expired and swept an hour later, and one captured
 * before the run's first observation would take the fallback and could die
 * before the replay that still reaches it. The sweep asks the run row again.
 */
export async function recordAgentBriefingRow(
  db: Db,
  input: RecordAgentBriefingRowInput,
): Promise<RecordAgentBriefingRowResult> {
  const texts = JSON.stringify(
    input.texts.map((entry) => ({ sha256: entry.sha256, body: entry.text, bytes: entry.bytes })),
  );
  const shas = JSON.stringify(input.texts.map((entry) => entry.sha256));
  const index = input.index === null ? null : JSON.stringify(input.index);
  const result = await db.execute(sql`
    WITH incoming AS (
      SELECT
        ${input.runId}::text AS run_id,
        ${input.nodeId}::text AS node_id,
        ${input.attempt}::integer AS attempt,
        ${input.activationScopeId}::text AS activation_scope_id,
        ${input.sequence}::integer AS sequence,
        ${input.kind}::text AS kind,
        ${input.capture}::text AS capture,
        ${index}::jsonb AS briefing_index,
        ${input.contentSha256}::text AS content_sha256,
        ARRAY(SELECT jsonb_array_elements_text(${shas}::jsonb)) AS text_sha256s,
        ${input.bytes}::integer AS bytes,
        ${input.detail}::text AS detail,
        ${input.capturedAt}::timestamptz AS captured_at
    ),
    inserted AS (
      INSERT INTO agent_briefings (
        run_id, node_id, attempt, activation_scope_id, sequence, kind, capture,
        briefing_index, content_sha256, text_sha256s, bytes, detail, captured_at, expires_at
      )
      SELECT
        incoming.run_id, incoming.node_id, incoming.attempt, incoming.activation_scope_id,
        incoming.sequence, incoming.kind, incoming.capture, incoming.briefing_index,
        incoming.content_sha256, incoming.text_sha256s, incoming.bytes, incoming.detail,
        incoming.captured_at,
        -- GREATEST ignores a null, so a run with no replay expiry keeps the floor.
        GREATEST(
          (SELECT run.replay_expires_at FROM workflow_runs run WHERE run.run_id = incoming.run_id),
          incoming.captured_at + ${sql.raw(`interval '${BRIEFING_RETENTION_DAYS} days'`)}
        )
      FROM incoming
      ON CONFLICT (run_id, node_id, attempt, activation_scope_id, sequence) DO NOTHING
      RETURNING id, kind, capture, content_sha256
    ),
    stored_texts AS (
      INSERT INTO agent_briefing_texts (sha256, text, bytes, last_referenced_at)
      SELECT entry.sha256, entry.body, entry.bytes, now()
      FROM jsonb_to_recordset(${texts}::jsonb) AS entry(sha256 text, body text, bytes integer)
      WHERE EXISTS (SELECT 1 FROM inserted)
      ON CONFLICT (sha256) DO UPDATE SET last_referenced_at = now()
      RETURNING sha256
    )
    SELECT 'inserted' AS outcome, inserted.id, inserted.kind, inserted.capture, inserted.content_sha256
    FROM inserted
    UNION ALL
    SELECT 'exists', stored.id, stored.kind, stored.capture, stored.content_sha256
    FROM agent_briefings stored, incoming
    WHERE NOT EXISTS (SELECT 1 FROM inserted)
      AND stored.run_id = incoming.run_id
      AND stored.node_id = incoming.node_id
      AND stored.attempt = incoming.attempt
      AND stored.activation_scope_id = incoming.activation_scope_id
      AND stored.sequence = incoming.sequence
  `);
  const [row] = rawRows<RecordedRow>(result);
  if (!row) return { outcome: "already_recorded", briefingId: null };
  if (row.outcome === "inserted") return { outcome: "recorded", briefingId: Number(row.id) };
  const same =
    row.kind === input.kind && row.capture === input.capture && row.content_sha256 === input.contentSha256;
  return same
    ? { outcome: "already_recorded", briefingId: Number(row.id) }
    : {
        outcome: "conflict",
        briefingId: Number(row.id),
        stored: { kind: row.kind, capture: row.capture, contentSha256: row.content_sha256 },
      };
}

export function recordConnectedAgentBriefingRow(
  input: RecordAgentBriefingRowInput,
): Promise<RecordAgentBriefingRowResult> {
  return recordAgentBriefingRow(getDb(), input);
}

/** What a send did, as the run's durable facts count it. */
export type AgentBriefingRunFact = "captured" | "disabled" | "skipped" | "failed" | "conflict";

/**
 * Bump one of a run's durable capture facts, and write the row if this is the
 * first send of the run.
 *
 * ONE STATEMENT, and its own: the row has to exist for every run whose code
 * could capture, including the runs where the briefing write itself wrote
 * nothing (the database was down, the detector refused, capture was off).
 * Without it, a run that tried and lost reads back as a run that predates
 * capture, which is a lie told exactly when something else has already gone
 * wrong. A replayed send bumps nothing, so the counts stay the counts of
 * sends.
 */
export async function recordAgentBriefingRunFact(
  db: Db,
  runId: string,
  fact: AgentBriefingRunFact,
): Promise<void> {
  const count = (name: AgentBriefingRunFact) => (fact === name ? 1 : 0);
  await db.execute(sql`
    INSERT INTO agent_briefing_runs (
      run_id, captured_count, disabled_count, skipped_count, failed_count, conflict_count,
      first_recorded_at, last_recorded_at
    )
    VALUES (
      ${runId}, ${count("captured")}, ${count("disabled")}, ${count("skipped")},
      ${count("failed")}, ${count("conflict")}, now(), now()
    )
    ON CONFLICT (run_id) DO UPDATE SET
      captured_count = agent_briefing_runs.captured_count + excluded.captured_count,
      disabled_count = agent_briefing_runs.disabled_count + excluded.disabled_count,
      skipped_count = agent_briefing_runs.skipped_count + excluded.skipped_count,
      failed_count = agent_briefing_runs.failed_count + excluded.failed_count,
      conflict_count = agent_briefing_runs.conflict_count + excluded.conflict_count,
      last_recorded_at = excluded.last_recorded_at
  `);
}

export function recordConnectedAgentBriefingRunFact(
  runId: string,
  fact: AgentBriefingRunFact,
): Promise<void> {
  return recordAgentBriefingRunFact(getDb(), runId, fact);
}

export interface AgentBriefingRow extends AgentBriefingIdentityRow {
  id: number;
  kind: string;
  capture: string;
  index: unknown;
  contentSha256: string | null;
  textSha256s: string[];
  bytes: number;
  detail: string | null;
  capturedAt: Date;
  expiresAt: Date;
}

export interface AgentBriefingRecord {
  briefing: AgentBriefingRow;
  /** The stored texts this briefing points at, by sha256. A briefing is never
   *  readable without them: they are written in the same statement it is. */
  texts: AgentBriefingTextRow[];
  /** A text the index points at that the store no longer holds. Always empty
   *  in practice; a reader that finds one must say so rather than show a gap. */
  missingTexts: string[];
}

interface BriefingRowShape {
  id: number;
  run_id: string;
  node_id: string;
  attempt: number;
  activation_scope_id: string;
  sequence: number;
  kind: string;
  capture: string;
  briefing_index: unknown;
  content_sha256: string | null;
  text_sha256s: string[];
  bytes: number;
  detail: string | null;
  captured_at: string | Date;
  expires_at: string | Date;
}

function mapBriefingRow(row: BriefingRowShape): AgentBriefingRow {
  return {
    id: Number(row.id),
    runId: row.run_id,
    nodeId: row.node_id,
    attempt: Number(row.attempt),
    activationScopeId: row.activation_scope_id,
    sequence: Number(row.sequence),
    kind: row.kind,
    capture: row.capture,
    index: row.briefing_index ?? null,
    contentSha256: row.content_sha256,
    textSha256s: row.text_sha256s ?? [],
    bytes: Number(row.bytes),
    detail: row.detail,
    capturedAt: new Date(row.captured_at),
    expiresAt: new Date(row.expires_at),
  };
}

/** One briefing with its texts, or null when the identity holds none. */
export async function readAgentBriefingRecord(
  db: Db,
  identity: AgentBriefingIdentityRow,
): Promise<AgentBriefingRecord | null> {
  const result = await db.execute(sql`
    SELECT
      stored.*,
      COALESCE(
        (
          SELECT jsonb_agg(jsonb_build_object('sha256', t.sha256, 'body', t.text, 'bytes', t.bytes))
          FROM agent_briefing_texts t
          WHERE t.sha256 = ANY(stored.text_sha256s)
        ),
        '[]'::jsonb
      ) AS texts
    FROM agent_briefings stored
    WHERE stored.run_id = ${identity.runId}
      AND stored.node_id = ${identity.nodeId}
      AND stored.attempt = ${identity.attempt}
      AND stored.activation_scope_id = ${identity.activationScopeId}
      AND stored.sequence = ${identity.sequence}
  `);
  const [row] = rawRows<BriefingRowShape & { texts: { sha256: string; body: string; bytes: number }[] }>(result);
  if (!row) return null;
  const briefing = mapBriefingRow(row);
  const byHash = new Map(row.texts.map((entry) => [entry.sha256, entry]));
  return {
    briefing,
    texts: briefing.textSha256s.flatMap((sha256) => {
      const entry = byHash.get(sha256);
      return entry ? [{ sha256, text: entry.body, bytes: Number(entry.bytes) }] : [];
    }),
    missingTexts: briefing.textSha256s.filter((sha256) => !byHash.has(sha256)),
  };
}

/** Every send of a run, in order, briefings and marker rows alike. */
export async function listAgentBriefingRowsOfRun(db: Db, runId: string): Promise<AgentBriefingRow[]> {
  const result = await db.execute(sql`
    SELECT stored.*
    FROM agent_briefings stored
    WHERE stored.run_id = ${runId}
    ORDER BY stored.node_id, stored.attempt, stored.activation_scope_id, stored.sequence
  `);
  return rawRows<BriefingRowShape>(result).map(mapBriefingRow);
}

export interface AgentBriefingRunSummary {
  runId: string;
  capturedCount: number;
  disabledCount: number;
  /** Sends the detector refused to store. */
  skippedCount: number;
  /** Sends whose write was lost. */
  failedCount: number;
  /** Sends that met a different briefing under their identity. */
  conflictCount: number;
  firstRecordedAt: Date;
  lastRecordedAt: Date;
}

/**
 * What this run's capture did, after its briefings are gone.
 *
 * THE ROW IS THE CAPABILITY: null means no capture-capable code ever ran in
 * this run, which is what the read model turns into "predates capture" rather
 * than a guess from a date. A row with nothing but failures says the opposite:
 * this run could capture, and the writes were lost.
 */
export async function readAgentBriefingRunSummary(
  db: Db,
  runId: string,
): Promise<AgentBriefingRunSummary | null> {
  const result = await db.execute(sql`
    SELECT * FROM agent_briefing_runs WHERE run_id = ${runId}
  `);
  const [row] = rawRows<{
    run_id: string;
    captured_count: number;
    disabled_count: number;
    skipped_count: number;
    failed_count: number;
    conflict_count: number;
    first_recorded_at: string | Date;
    last_recorded_at: string | Date;
  }>(result);
  if (!row) return null;
  return {
    runId: row.run_id,
    capturedCount: Number(row.captured_count),
    disabledCount: Number(row.disabled_count),
    skippedCount: Number(row.skipped_count),
    failedCount: Number(row.failed_count),
    conflictCount: Number(row.conflict_count),
    firstRecordedAt: new Date(row.first_recorded_at),
    lastRecordedAt: new Date(row.last_recorded_at),
  };
}

export interface ClarificationAnswerDeliveryInput {
  clarificationId: string;
  /** Already redacted by the caller. */
  words: string;
  authorKind: "person" | "several_people";
  authorDisplay: string;
  surface: "jira" | "dashboard" | "mcp" | "other";
  /** The one reading of these words, or null where they were not read. */
  reading: unknown;
  /** What was posted back to the person, or null when nothing was. */
  note: string | null;
  at: Date;
}

export type AppendClarificationAnswerDeliveryResult =
  | { outcome: "appended"; deliveryId: number; count: number }
  | { outcome: "merged"; deliveryId: number; count: number };

/** How many times one statement may lose the race for the chain's end before
 *  the caller is told the delivery could not be written. */
const DELIVERY_APPEND_ATTEMPTS = 3;

/**
 * One arrival of an answer, merged into the latest delivery when it is the
 * same one arriving again.
 *
 * THE SAME DELIVERY is the same words, the same author, the same surface and
 * the same reading verdict (its outcome kind and whether a model or the
 * deterministic fallback read it), whatever the times say. So a weekend of
 * poll ticks re-composing one unclear answer is one row with a count, while
 * the same words read as unclear and later as a selection are two.
 *
 * THE CHAIN DECIDES THE RACE. A webhook and a poll tick composing the same new
 * words at the same moment both follow the same latest row; the unique index
 * on (clarification, previous) lets one of them insert, and the other either
 * merges into it or, if the words differ after all, retries against the new
 * end of the chain.
 */
export async function appendClarificationAnswerDelivery(
  db: Db,
  input: ClarificationAnswerDeliveryInput,
): Promise<AppendClarificationAnswerDeliveryResult | null> {
  const reading = input.reading === null || input.reading === undefined ? null : JSON.stringify(input.reading);
  for (let attempt = 0; attempt < DELIVERY_APPEND_ATTEMPTS; attempt += 1) {
    const result = await db.execute(sql`
      WITH incoming AS (
        SELECT
          ${input.clarificationId}::text AS clarification_id,
          ${input.words}::text AS words,
          ${input.authorKind}::text AS author_kind,
          ${input.authorDisplay}::text AS author_display,
          ${input.surface}::text AS surface,
          ${reading}::jsonb AS reading,
          ${input.note}::text AS note,
          ${input.at}::timestamptz AS at
      ),
      latest AS (
        SELECT delivery.*
        FROM clarification_answer_deliveries delivery, incoming
        WHERE delivery.clarification_id = incoming.clarification_id
        ORDER BY delivery.id DESC
        LIMIT 1
      ),
      same AS (
        SELECT latest.id
        FROM latest, incoming
        WHERE latest.words = incoming.words
          AND latest.author_kind = incoming.author_kind
          AND latest.author_display = incoming.author_display
          AND latest.surface = incoming.surface
          AND (latest.reading -> 'outcome' ->> 'kind') IS NOT DISTINCT FROM (incoming.reading -> 'outcome' ->> 'kind')
          AND (latest.reading ->> 'readBy') IS NOT DISTINCT FROM (incoming.reading ->> 'readBy')
      ),
      bumped AS (
        UPDATE clarification_answer_deliveries delivery
        SET count = delivery.count + 1,
            last_at = GREATEST(delivery.last_at, incoming.at),
            note = COALESCE(delivery.note, incoming.note)
        FROM same, incoming
        WHERE delivery.id = same.id
        RETURNING delivery.id, delivery.count
      ),
      appended AS (
        INSERT INTO clarification_answer_deliveries (
          clarification_id, previous_id, words, author_kind, author_display, surface, reading, note,
          first_at, last_at, count
        )
        SELECT
          incoming.clarification_id,
          COALESCE((SELECT latest.id FROM latest), 0),
          incoming.words, incoming.author_kind, incoming.author_display, incoming.surface,
          incoming.reading, incoming.note, incoming.at, incoming.at, 1
        FROM incoming
        WHERE NOT EXISTS (SELECT 1 FROM same)
        ON CONFLICT (clarification_id, previous_id) DO UPDATE
          SET count = clarification_answer_deliveries.count + 1,
              last_at = GREATEST(clarification_answer_deliveries.last_at, excluded.last_at),
              note = COALESCE(clarification_answer_deliveries.note, excluded.note)
          WHERE clarification_answer_deliveries.words = excluded.words
            AND clarification_answer_deliveries.author_kind = excluded.author_kind
            AND clarification_answer_deliveries.author_display = excluded.author_display
            AND clarification_answer_deliveries.surface = excluded.surface
            AND (clarification_answer_deliveries.reading -> 'outcome' ->> 'kind')
              IS NOT DISTINCT FROM (excluded.reading -> 'outcome' ->> 'kind')
            AND (clarification_answer_deliveries.reading ->> 'readBy')
              IS NOT DISTINCT FROM (excluded.reading ->> 'readBy')
        RETURNING id, count, (xmax = 0) AS fresh
      )
      SELECT bumped.id, bumped.count, 'merged' AS outcome FROM bumped
      UNION ALL
      SELECT appended.id, appended.count, CASE WHEN appended.fresh THEN 'appended' ELSE 'merged' END
      FROM appended
    `);
    const [row] = rawRows<{ id: number; count: number; outcome: "appended" | "merged" }>(result);
    if (row) return { outcome: row.outcome, deliveryId: Number(row.id), count: Number(row.count) };
  }
  return null;
}

export function appendConnectedClarificationAnswerDelivery(
  input: ClarificationAnswerDeliveryInput,
): Promise<AppendClarificationAnswerDeliveryResult | null> {
  return appendClarificationAnswerDelivery(getDb(), input);
}

export interface ClarificationAnswerDeliveryRow {
  id: number;
  clarificationId: string;
  words: string;
  authorKind: string;
  authorDisplay: string;
  surface: string;
  reading: unknown;
  note: string | null;
  firstAt: Date;
  lastAt: Date;
  count: number;
}

/** Every delivery of these clarifications, oldest first. */
export async function listClarificationAnswerDeliveryRows(
  db: Db,
  clarificationIds: readonly string[],
): Promise<ClarificationAnswerDeliveryRow[]> {
  if (clarificationIds.length === 0) return [];
  const result = await db.execute(sql`
    SELECT *
    FROM clarification_answer_deliveries
    WHERE clarification_id = ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(clarificationIds)}::jsonb)))
    ORDER BY id
  `);
  return rawRows<{
    id: number;
    clarification_id: string;
    words: string;
    author_kind: string;
    author_display: string;
    surface: string;
    reading: unknown;
    note: string | null;
    first_at: string | Date;
    last_at: string | Date;
    count: number;
  }>(result).map((row) => ({
    id: Number(row.id),
    clarificationId: row.clarification_id,
    words: row.words,
    authorKind: row.author_kind,
    authorDisplay: row.author_display,
    surface: row.surface,
    reading: row.reading ?? null,
    note: row.note,
    firstAt: new Date(row.first_at),
    lastAt: new Date(row.last_at),
    count: Number(row.count),
  }));
}

export interface DeleteExpiredAgentBriefingsInput {
  db: Db;
  now?: Date;
  limit?: number;
}

export interface DeleteExpiredAgentBriefingsResult {
  briefings: number;
  texts: number;
}

/**
 * The briefings whose retention has passed, and the texts nothing points at
 * any more.
 *
 * ONE STATEMENT, and safe to run beside a capture. A briefing younger than the
 * sweep grace is left for the next pass, so every text it released was last
 * pointed at before the grace too, and a text a capture has just touched is
 * skipped because the DELETE re-evaluates the row that capture updated. The
 * candidates are only the texts the deleted briefings released, so no pass
 * reads the whole table.
 *
 * Briefings carry their own expiry (the later of the run's replay expiry and
 * thirty days from the send), so a run parked past day thirty, a run whose
 * observations were never captured, and a pass that failed halfway all expire
 * on a later pass rather than staying for good. The run row is read again
 * here, so a replay whose expiry moved out after the send keeps the briefings
 * it can still show.
 */
export async function deleteExpiredAgentBriefings(
  input: DeleteExpiredAgentBriefingsInput,
): Promise<DeleteExpiredAgentBriefingsResult> {
  const now = input.now ?? new Date();
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_BRIEFING_CLEANUP_LIMIT, 1), 1_000);
  const grace = sql.raw(`interval '${TEXT_SWEEP_GRACE_MINUTES} minutes'`);
  const result = await input.db.execute(sql`
    WITH due AS (
      SELECT stored.id
      FROM agent_briefings stored
      WHERE stored.expires_at <= ${now}
        AND stored.created_at < ${now}::timestamptz - ${grace}
        AND NOT EXISTS (
          SELECT 1
          FROM workflow_runs run
          WHERE run.run_id = stored.run_id
            AND run.replay_expires_at > ${now}
        )
      ORDER BY stored.expires_at ASC, stored.id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    ),
    deleted AS (
      DELETE FROM agent_briefings stored
      USING due
      WHERE stored.id = due.id
      RETURNING stored.id, stored.text_sha256s
    ),
    released AS (
      SELECT DISTINCT unnest(deleted.text_sha256s) AS sha256 FROM deleted
    ),
    swept AS (
      DELETE FROM agent_briefing_texts stored
      USING released
      WHERE stored.sha256 = released.sha256
        AND stored.last_referenced_at < ${now}::timestamptz - ${grace}
        AND NOT EXISTS (
          SELECT 1
          FROM agent_briefings other
          WHERE other.text_sha256s @> ARRAY[stored.sha256]
            AND other.id NOT IN (SELECT deleted.id FROM deleted)
        )
      RETURNING stored.sha256
    )
    SELECT
      (SELECT count(*)::integer FROM deleted) AS briefings,
      (SELECT count(*)::integer FROM swept) AS texts
  `);
  const [row] = rawRows<{ briefings: number; texts: number }>(result);
  return { briefings: Number(row?.briefings ?? 0), texts: Number(row?.texts ?? 0) };
}

export function deleteConnectedExpiredAgentBriefings(
  input: Omit<DeleteExpiredAgentBriefingsInput, "db">,
): Promise<DeleteExpiredAgentBriefingsResult> {
  return deleteExpiredAgentBriefings({ ...input, db: getDb() });
}
