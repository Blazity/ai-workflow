import { and, asc, desc, eq, inArray, lt, sql, type SQL } from "drizzle-orm";
import {
  workScopeOriginRank,
  type WorkScope,
  type WorkScopeActor,
  type WorkScopeEntry,
  type WorkScopeTrailEvent,
  type WorkScopeTrailRow,
  type WorkScopeWritePlan,
} from "@shared/contracts";
import { getDb, type Db } from "../client.js";
import { workScopeEntries, workScopes, workScopeTrail } from "../schema.js";

const TRAIL_PAGE_LIMIT_MAX = 200;

interface StoredEntry {
  repositoryKey: string;
  state: WorkScopeEntry["state"];
  unavailableReason: WorkScopeEntry["unavailableReason"] | null;
  origin: WorkScopeEntry["origin"];
  rationale: string;
  decidedBy: WorkScopeActor;
  decidedAt: Date | string;
}

function toEntry(row: StoredEntry): WorkScopeEntry {
  return {
    repositoryKey: row.repositoryKey,
    state: row.state,
    // The contract's entry is strict: absent, not null, off the unavailable state.
    ...(row.unavailableReason ? { unavailableReason: row.unavailableReason } : {}),
    origin: row.origin,
    rationale: row.rationale,
    decidedBy: row.decidedBy,
    decidedAt: new Date(row.decidedAt).toISOString(),
  };
}

/**
 * The subject's work scope, or null when nothing was ever written for it.
 *
 * One statement, so the version and the entries come from one snapshot: a
 * version read after the entries could be newer than what the entries show,
 * and a person editing that view would overwrite a change they never saw.
 */
export async function readWorkScope(db: Db, subjectKey: string): Promise<WorkScope | null> {
  const rows = await db
    .select({
      version: workScopes.version,
      repositoryKey: workScopeEntries.repositoryKey,
      state: workScopeEntries.state,
      unavailableReason: workScopeEntries.unavailableReason,
      origin: workScopeEntries.origin,
      rationale: workScopeEntries.rationale,
      decidedBy: workScopeEntries.decidedBy,
      decidedAt: workScopeEntries.decidedAt,
    })
    .from(workScopes)
    .leftJoin(workScopeEntries, eq(workScopeEntries.subjectKey, workScopes.subjectKey))
    .where(eq(workScopes.subjectKey, subjectKey))
    // Byte order, so the order does not depend on the database's collation.
    .orderBy(asc(workScopeEntries.originRank), sql`${workScopeEntries.repositoryKey} collate "C"`);
  const first = rows[0];
  if (!first) return null;
  const entries: WorkScopeEntry[] = [];
  for (const row of rows) {
    if (row.repositoryKey === null) continue;
    entries.push(toEntry(row as StoredEntry));
  }
  return { subjectKey, version: first.version, entries };
}

/**
 * Whether a person has already answered the "which of these repositories"
 * question on this subject.
 *
 * It is read from the trail rather than from the entries because that answer
 * can record nothing: "none of these" writes no entry by design, so a run
 * looking at the entries alone could not tell the question from one nobody ever
 * asked, and would ask it again on its next start. An `unrecognised` answer
 * leaves this false: nobody decided anything, so a later run may ask once more.
 *
 * One statement, and the answer must sit on the SAME subject as the question:
 * the record is per subject, and a clarification id is the only thing the two
 * rows share.
 */
export async function readWorkScopeSelectionAnswered(
  db: Db,
  subjectKey: string,
): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT EXISTS (
      SELECT 1
      FROM ${workScopeTrail} AS asked
      JOIN ${workScopeTrail} AS given
        ON given.subject_key = asked.subject_key
        AND given.kind = 'question_answered'
        AND given.event ->> 'clarificationId' = asked.event ->> 'clarificationId'
      WHERE asked.subject_key = ${subjectKey}::text
        AND asked.kind = 'question_asked'
        AND given.event -> 'answer' ->> 'kind' IN ('none', 'repositories')
        -- The question is the selection one when ANY repository it named was
        -- asked about for that reason; a question mixing reasons still asked it.
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(asked.event -> 'repositories') AS repository
          WHERE repository ->> 'askedBecause' = 'selection'
        )
    ) AS answered
  `);
  const row = (result as { rows?: Array<{ answered: boolean }> }).rows?.[0];
  if (!row) throw new Error("work scope selection read returned no row");
  return row.answered;
}

/**
 * Newest first. `nextBeforeId` is the `beforeId` of the following page.
 *
 * `kinds` narrows to those event kinds; empty or absent means every kind. It
 * filters the (subject or run, id) index scan rather than having an index of
 * its own, because the one narrowed read, whether a person already answered a
 * question on this subject, walks a single subject's trail.
 */
export async function listWorkScopeTrail(
  db: Db,
  filter: ({ subjectKey: string } | { runId: string }) & { kinds?: WorkScopeTrailEvent["kind"][] },
  page: { limit: number; beforeId?: number },
): Promise<{ rows: WorkScopeTrailRow[]; nextBeforeId: number | null }> {
  if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > TRAIL_PAGE_LIMIT_MAX) {
    throw new RangeError(`trail page limit must be an integer from 1 to ${TRAIL_PAGE_LIMIT_MAX}`);
  }
  const owner =
    "subjectKey" in filter
      ? eq(workScopeTrail.subjectKey, filter.subjectKey)
      : eq(workScopeTrail.runId, filter.runId);
  // One row past the page says whether another page exists without a count.
  const rows = await db
    .select()
    .from(workScopeTrail)
    .where(
      and(
        owner,
        filter.kinds && filter.kinds.length > 0
          ? inArray(workScopeTrail.kind, filter.kinds)
          : undefined,
        page.beforeId === undefined ? undefined : lt(workScopeTrail.id, page.beforeId),
      ),
    )
    .orderBy(desc(workScopeTrail.id))
    .limit(page.limit + 1);
  const pageRows = rows.slice(0, page.limit);
  const last = pageRows.at(-1);
  return {
    rows: pageRows.map((row) => ({
      id: row.id,
      subjectKey: row.subjectKey,
      runId: row.runId,
      at: row.at.toISOString(),
      event: row.event,
    })),
    nextBeforeId: rows.length > page.limit && last ? last.id : null,
  };
}

/** The single repository an event is about, when it is about exactly one. */
function trailRepositoryKey(event: WorkScopeTrailEvent): string | null {
  // An entry written or removed is about its entry's repository; a question or
  // a map names several, so none of them is the row's repository.
  if ("entry" in event) return event.entry.repositoryKey;
  if (event.kind === "request_refused") return event.repositoryKey;
  return null;
}

function incomingEntriesJson(plan: WorkScopeWritePlan): string {
  return JSON.stringify(
    plan.upserts.map(({ entry }) => ({
      repository_key: entry.repositoryKey,
      state: entry.state,
      unavailable_reason: entry.unavailableReason ?? null,
      origin: entry.origin,
      origin_rank: workScopeOriginRank(entry.origin),
      rationale: entry.rationale,
      decided_by: entry.decidedBy,
      decided_at: entry.decidedAt,
    })),
  );
}

function deletesJson(plan: WorkScopeWritePlan): string {
  return JSON.stringify(
    plan.deletes.map((deletion) => ({
      repository_key: deletion.repositoryKey,
      origin: deletion.origin,
    })),
  );
}

/**
 * Whether the upsert for `column`'s key is one the plan marks `replacesExpired`.
 *
 * Spelled as a key list because a conflict clause sees only the target row and
 * the proposed row, and the flag is not a column of either. The plan upserts
 * each key at most once, so the key identifies the upsert.
 */
function expiredKeysPredicate(plan: WorkScopeWritePlan, column: SQL) {
  const keys = plan.upserts
    .filter((upsert) => upsert.replacesExpired)
    .map((upsert) => sql`${upsert.entry.repositoryKey}::text`);
  if (keys.length === 0) return sql`FALSE`;
  return sql`${column} IN (${sql.join(keys, sql`, `)})`;
}

/**
 * Whether the `proposed` entry may overwrite the `stored` row for its key.
 *
 * One fragment for the snapshot prediction and for the conflict clause, so the
 * version cannot be moved by one rule while the row is written by another.
 * Rank 0 wins, and an origin overwrites its own kind: a corrected ticket
 * replaces the ticket text entry it wrote before. The one case a lower origin
 * may overwrite a higher one is an upsert the plan marks `replacesExpired`,
 * over an unavailable row of either reason. Whether it has expired is the
 * decision module's call; the store only refuses to let such a write replace
 * an exclusion or a selection.
 */
function overwriteAllowed(plan: WorkScopeWritePlan, proposed: SQL, stored: SQL) {
  return sql`(
    ${proposed}.origin_rank <= ${stored}.origin_rank
    OR (
      ${expiredKeysPredicate(plan, sql`${proposed}.repository_key`)}
      AND ${stored}.state = 'unavailable'
    )
  )`;
}

/**
 * Whether the `stored` row is the one a removal names: same key, and still the
 * origin its writer saw, so a person who took the repository over in the
 * meantime is not undone by a run dropping its text match. Shared by the
 * prediction and the delete for the same reason as `overwriteAllowed`.
 */
function removalMatches(removal: SQL, stored: SQL) {
  return sql`(
    ${stored}.repository_key = ${removal}.repository_key
    AND ${stored}.origin = ${removal}.origin
  )`;
}

/** The columns a `trailEventsJson` document is read back as. */
const TRAIL_EVENT_COLUMNS = sql`ordinal integer, kind text, repository_key text, event jsonb`;

/** Answer rows are keyed once per clarification, so they are written only by
 *  `applyAnswerWorkScopePlan`: through any other path one would either break
 *  the unique index or make the real answer read as already applied and drop
 *  its entries. */
function refuseAnswerEvents(plan: WorkScopeWritePlan): void {
  if (plan.trail.some((event) => event.kind === "question_answered")) {
    throw new Error("A question_answered event is written only through the answer path.");
  }
}

function trailEventsJson(plan: WorkScopeWritePlan): string {
  return JSON.stringify(
    plan.trail.map((event, ordinal) => ({
      ordinal,
      kind: event.kind,
      repository_key: trailRepositoryKey(event),
      event,
    })),
  );
}

/**
 * The data-modifying CTE chain every write shares, as ONE statement: neon-http
 * cannot open an interactive transaction, and the version, the entries and the
 * trail must move together or not at all.
 *
 * Order matters, and it is forced by which CTE reads which:
 * - `answered` is the answer-once gate (a constant row for any other write).
 * - `predicted` says, from this statement's snapshot, whether the plan changes
 *   an entry row. It is built from the same `overwriteAllowed` and
 *   `removalMatches` fragments as `upserted` and `deleted`, so it cannot drift
 *   from what they write.
 * - `scope` locks the version row before any entry row is touched, in every
 *   writer, and moves the version only for a change. Under that lock the
 *   snapshot is exact whenever the stored version still equals the snapshot's:
 *   every writer that changes an entry also moves the version. When it does
 *   not equal, the snapshot is stale and the version moves anyway, because a
 *   spurious conflict for a person is harmless and a missed move is not.
 * - `applied` is whether this write happens at all: false only for a person's
 *   stale version or an answer already recorded.
 * - `upserted` and `deleted` read `scope`; `appended` reads `applied` and their
 *   RETURNING, so the trail never claims a change the record did not take.
 */
function writePlanStatement(input: {
  subjectKey: string;
  runId: string | null;
  plan: WorkScopeWritePlan;
  expectedVersion: number | null;
  answerOnce?: WorkScopeTrailEvent;
}) {
  const { plan } = input;
  const expected =
    input.expectedVersion === null ? sql`NULL::integer` : sql`${input.expectedVersion}::integer`;
  const answered = input.answerOnce
    ? sql`
      INSERT INTO ${workScopeTrail} (subject_key, run_id, kind, repository_key, event)
      VALUES (
        ${input.subjectKey}::text, ${input.runId}::text, 'question_answered', NULL,
        ${JSON.stringify(input.answerOnce)}::jsonb
      )
      ON CONFLICT ((event ->> 'clarificationId')) WHERE kind = 'question_answered'
      DO NOTHING
      RETURNING id`
    : sql`SELECT 1 AS id`;
  return sql`
    WITH answered AS (${answered}
    ), stored_version AS (
      SELECT
        COALESCE(stored.version, 0) AS version,
        stored.subject_key IS NOT NULL AS present
      FROM (SELECT 1) AS anchor
      LEFT JOIN ${workScopes} AS stored ON stored.subject_key = ${input.subjectKey}::text
    ), incoming AS (
      SELECT *
      FROM jsonb_to_recordset(${incomingEntriesJson(plan)}::jsonb) AS incoming(
        repository_key text, state text, unavailable_reason text, origin text,
        origin_rank smallint, rationale text, decided_by jsonb, decided_at timestamptz
      )
    ), removals AS (
      SELECT *
      FROM jsonb_to_recordset(${deletesJson(plan)}::jsonb) AS removals(
        repository_key text, origin text
      )
    ), predicted AS (
      SELECT (
        EXISTS (
          SELECT 1
          FROM incoming
          LEFT JOIN ${workScopeEntries} AS stored
            ON stored.subject_key = ${input.subjectKey}::text
           AND stored.repository_key = incoming.repository_key
          WHERE stored.repository_key IS NULL
            OR ${overwriteAllowed(plan, sql`incoming`, sql`stored`)}
        )
        OR EXISTS (
          SELECT 1
          FROM removals
          JOIN ${workScopeEntries} AS stored
            ON stored.subject_key = ${input.subjectKey}::text
           AND ${removalMatches(sql`removals`, sql`stored`)}
        )
      ) AS changes
    ), scope AS (
      INSERT INTO ${workScopes} (subject_key, version, updated_at)
      SELECT ${input.subjectKey}::text, 1, now()
      FROM stored_version, predicted, answered
      WHERE (${expected} IS NULL OR ${expected} = stored_version.version)
        -- With no row and no change there is nothing to lock and nothing to
        -- count, so a plan of refusals on a new subject creates no record.
        AND (stored_version.present OR predicted.changes)
      ON CONFLICT (subject_key) DO UPDATE SET
        version = ${workScopes}.version + CASE
          WHEN (SELECT changes FROM predicted)
            OR ${workScopes}.version <> (SELECT version FROM stored_version)
          THEN 1 ELSE 0 END,
        updated_at = CASE
          WHEN (SELECT changes FROM predicted)
            OR ${workScopes}.version <> (SELECT version FROM stored_version)
          THEN now() ELSE ${workScopes}.updated_at END
        -- The predicate travels with the write. stored_version is what this
        -- statement's snapshot saw; restating the version against the row being
        -- updated is what refuses a writer that committed after that snapshot,
        -- including one that created the row a person expected not to exist.
        WHERE ${expected} IS NULL OR ${workScopes}.version = ${expected}
      RETURNING subject_key, version
    ), applied AS (
      SELECT 1 AS applied
      FROM stored_version, predicted, answered
      WHERE (${expected} IS NULL OR ${expected} = stored_version.version)
        AND (
          NOT (stored_version.present OR predicted.changes)
          OR EXISTS (SELECT 1 FROM scope)
        )
    ), upserted AS (
      INSERT INTO ${workScopeEntries} (
        subject_key, repository_key, state, unavailable_reason, origin,
        origin_rank, rationale, decided_by, decided_at
      )
      SELECT
        scope.subject_key, incoming.repository_key, incoming.state,
        incoming.unavailable_reason, incoming.origin, incoming.origin_rank,
        incoming.rationale, incoming.decided_by, incoming.decided_at
      FROM scope, incoming
      ON CONFLICT (subject_key, repository_key) DO UPDATE SET
        state = EXCLUDED.state,
        unavailable_reason = EXCLUDED.unavailable_reason,
        origin = EXCLUDED.origin,
        origin_rank = EXCLUDED.origin_rank,
        rationale = EXCLUDED.rationale,
        decided_by = EXCLUDED.decided_by,
        decided_at = EXCLUDED.decided_at
      WHERE ${overwriteAllowed(plan, sql`EXCLUDED`, sql`${workScopeEntries}`)}
      RETURNING repository_key, state, unavailable_reason, origin, origin_rank,
        rationale, decided_by, decided_at
    ), deleted AS (
      DELETE FROM ${workScopeEntries} AS stored
      USING scope, removals
      WHERE stored.subject_key = scope.subject_key
        AND ${removalMatches(sql`removals`, sql`stored`)}
      RETURNING stored.repository_key
    ), appended AS (
      INSERT INTO ${workScopeTrail} (subject_key, run_id, kind, repository_key, event)
      SELECT ${input.subjectKey}::text, ${input.runId}::text, event.kind,
        event.repository_key, event.event
      FROM applied, jsonb_to_recordset(${trailEventsJson(plan)}::jsonb)
        AS event(${TRAIL_EVENT_COLUMNS})
      -- The entries are the fold of the trail, so a line saying an entry was
      -- written or removed exists only when the statement did write or remove
      -- it. A refused upsert or a missed delete is a lost race, and a missing
      -- line is honest where a false one is not.
      WHERE (
          event.kind <> 'entry_written'
          OR event.repository_key IN (SELECT repository_key FROM upserted)
        )
        AND (
          event.kind <> 'entry_removed'
          OR event.repository_key IN (SELECT repository_key FROM deleted)
        )
      -- The plan's order is the order the ids are drawn in, so newest first
      -- reads the plan backwards rather than in an arbitrary order.
      ORDER BY event.ordinal
      RETURNING id
    )
  `;
}

/**
 * A run's write. It carries no expected version and cannot conflict, because
 * the step that makes it runs without retries and a conflict there would kill
 * a run whose sandbox already exists; origin precedence decides instead.
 *
 * `version` is the subject's version as it stands after the write: unchanged
 * when no entry changed, 0 when the subject still has no record, null when
 * there is no subject.
 */
export async function applyRunWorkScopePlan(
  db: Db,
  input: { subjectKey: string | null; runId: string; plan: WorkScopeWritePlan },
): Promise<{ version: number | null }> {
  const { plan } = input;
  refuseAnswerEvents(plan);
  if (input.subjectKey === null) {
    // A schedule or a subjectless webhook delivery has no record to hold an
    // entry, so an entry, or a line saying one was written or removed, is a
    // caller bug, refused before any SQL rather than half written.
    if (
      plan.upserts.length > 0 ||
      plan.deletes.length > 0 ||
      plan.trail.some((event) => event.kind === "entry_written" || event.kind === "entry_removed")
    ) {
      throw new Error("A run with no subject writes no entry and no entry event.");
    }
    if (plan.trail.length === 0) return { version: null };
    await db.execute(sql`
      INSERT INTO ${workScopeTrail} (subject_key, run_id, kind, repository_key, event)
      SELECT NULL, ${input.runId}::text, event.kind, event.repository_key, event.event
      FROM jsonb_to_recordset(${trailEventsJson(plan)}::jsonb) AS event(${TRAIL_EVENT_COLUMNS})
      ORDER BY event.ordinal
    `);
    return { version: null };
  }
  const result = await db.execute(sql`
    ${writePlanStatement({
      subjectKey: input.subjectKey,
      runId: input.runId,
      plan,
      expectedVersion: null,
    })}
    SELECT COALESCE((SELECT version FROM scope), stored_version.version) AS version
    FROM stored_version
  `);
  const row = (result as { rows?: Array<{ version: number }> }).rows?.[0];
  if (!row) throw new Error("work scope write returned no version");
  return { version: Number(row.version) };
}

/**
 * A person's edit: the whole change set as one write carrying the version the
 * person read, so a run or another person writing in between is a conflict the
 * panel shows rather than a silently lost update. The person is named by the
 * plan itself, on its entries and its removals.
 *
 * Under a race, `currentVersion` in a conflict can equal the expected version,
 * so a caller re-reads the scope rather than retrying with that number.
 */
export async function applyPersonWorkScopeEdit(
  db: Db,
  input: { subjectKey: string; expectedVersion: number; plan: WorkScopeWritePlan },
): Promise<
  { outcome: "applied"; scope: WorkScope } | { outcome: "conflict"; currentVersion: number }
> {
  refuseAnswerEvents(input.plan);
  const result = await db.execute(sql`
    ${writePlanStatement({
      subjectKey: input.subjectKey,
      runId: null,
      plan: input.plan,
      expectedVersion: input.expectedVersion,
    })}
    SELECT
      EXISTS (SELECT 1 FROM applied) AS applied,
      COALESCE((SELECT version FROM scope), stored_version.version) AS version,
      stored_version.version AS current_version,
      merged.repository_key AS "repositoryKey",
      merged.state,
      merged.unavailable_reason AS "unavailableReason",
      merged.origin,
      merged.rationale,
      merged.decided_by AS "decidedBy",
      merged.decided_at AS "decidedAt"
    FROM stored_version
    -- The scope as written. A CTE's writes are invisible to the rest of its
    -- statement, so the entries are what this write returned plus the stored
    -- rows it neither upserted nor deleted. An applied edit passed the version
    -- check under the version row lock, so its snapshot rows are the current
    -- ones.
    LEFT JOIN (
      SELECT repository_key, state, unavailable_reason, origin, origin_rank,
        rationale, decided_by, decided_at
      FROM upserted
      UNION ALL
      SELECT stored.repository_key, stored.state, stored.unavailable_reason,
        stored.origin, stored.origin_rank, stored.rationale, stored.decided_by,
        stored.decided_at
      FROM ${workScopeEntries} AS stored
      WHERE stored.subject_key = ${input.subjectKey}::text
        AND stored.repository_key NOT IN (SELECT repository_key FROM upserted)
        AND stored.repository_key NOT IN (SELECT repository_key FROM deleted)
    ) AS merged ON EXISTS (SELECT 1 FROM applied)
    ORDER BY merged.origin_rank, merged.repository_key COLLATE "C"
  `);
  const rows =
    (
      result as {
        rows?: Array<
          { applied: boolean; version: number; current_version: number } & {
            [K in keyof StoredEntry]: StoredEntry[K] | null;
          }
        >;
      }
    ).rows ?? [];
  const first = rows[0];
  if (!first) throw new Error("work scope edit returned no outcome");
  if (!first.applied) {
    // The version this statement's snapshot saw. When the refusal came from a
    // writer that committed after the snapshot, it can equal the expected
    // version; the answer is still "read the scope again", which is what a
    // conflict tells the panel to do.
    return { outcome: "conflict", currentVersion: Number(first.current_version) };
  }
  const entries: WorkScopeEntry[] = [];
  for (const row of rows) {
    if (row.repositoryKey === null) continue;
    entries.push(toEntry(row as StoredEntry));
  }
  return {
    outcome: "applied",
    scope: { subjectKey: input.subjectKey, version: Number(first.version), entries },
  };
}

/**
 * A person's answer to a repository question, written when the answer arrives.
 *
 * The answer service can be retried with the same answer after a lost
 * response, so the write is keyed on the clarification: the plan's one
 * `question_answered` event is inserted first against a unique index, and a
 * retry that meets it writes nothing else. Precedence, `replacesExpired` and
 * compare-and-delete are those of a run's plan, with no expected version.
 */
export async function applyAnswerWorkScopePlan(
  db: Db,
  input: { subjectKey: string; runId: string; clarificationId: string; plan: WorkScopeWritePlan },
): Promise<{ outcome: "applied"; version: number } | { outcome: "already_applied" }> {
  // Exactly one answer, and it is this clarification's: a second one would
  // bypass the answer-once gate its own clarification needs.
  const answers = input.plan.trail.filter((event) => event.kind === "question_answered");
  const [answer] = answers;
  if (
    answers.length !== 1 ||
    answer?.kind !== "question_answered" ||
    answer.clarificationId !== input.clarificationId
  ) {
    throw new Error(
      `An answer plan carries exactly one question_answered event for "${input.clarificationId}".`,
    );
  }
  const result = await db.execute(sql`
    ${writePlanStatement({
      subjectKey: input.subjectKey,
      runId: input.runId,
      plan: { ...input.plan, trail: input.plan.trail.filter((event) => event !== answer) },
      expectedVersion: null,
      answerOnce: answer,
    })}
    SELECT
      EXISTS (SELECT 1 FROM answered) AS answered,
      COALESCE((SELECT version FROM scope), stored_version.version) AS version
    FROM stored_version
  `);
  const row = (result as { rows?: Array<{ answered: boolean; version: number }> }).rows?.[0];
  if (!row) throw new Error("work scope answer returned no outcome");
  if (!row.answered) return { outcome: "already_applied" };
  return { outcome: "applied", version: Number(row.version) };
}

/**
 * The two reads the run start makes, against the process-wide connection.
 *
 * The run-start step takes no database handle: it is the engine's one read of a
 * store, and it reaches it exactly as it reaches settings and the catalog. The
 * precedent is `listConnectedRepositoryCatalogKeys`
 * (`db/repositories/repository-catalog.ts:1119-1126`).
 */
export function readConnectedWorkScope(subjectKey: string) {
  return readWorkScope(getDb(), subjectKey);
}

export function readConnectedWorkScopeSelectionAnswered(subjectKey: string) {
  return readWorkScopeSelectionAnswered(getDb(), subjectKey);
}
