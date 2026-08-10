import { and, asc, desc, eq, getTableColumns, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { activeRuns, scheduleOccurrences, workflowSchedules } from "../db/schema.js";

/**
 * Durable occurrence ledger for schedule triggers.
 *
 * The idempotency story is the primary key and nothing else. An occurrence
 * instant is computed from the cron expression, so re-evaluating the same
 * occurrence reproduces an identical (schedule_id, occurrence_at) key and the
 * second write is a conflict rather than a second expensive agent run. There is
 * no fallback identity and therefore no edge case: contrast the webhook inbox,
 * which has to hash the request body into a six-hour tumbling bucket when a
 * sender omits a delivery id, and consequently has a bucket boundary where the
 * same body can be admitted twice.
 *
 * Two states, and the difference decides what every writer below may do:
 *   - PENDING means the occurrence is still waiting for the drain. It may carry a
 *     skip_reason and a non-zero attempt_count, which are annotations about
 *     attempts that failed or were deferred, not decisions.
 *   - SETTLED means pending is false AND outcome is not null. Settled is
 *     TERMINAL. Nothing may reopen it, which is what stops a cancelled, expired
 *     or superseded occurrence from being resurrected into a run.
 *
 * At most one occurrence per schedule is pending, enforced by a partial unique
 * index rather than by any read-then-write check. An occurrence that is due while
 * that slot is taken still gets a row: settled immediately as skipped_overlap
 * (skip and allow) or taking the slot from the older one (queue). That caps the
 * deferral queue at one entry by design, and leaves no silent gap in the ledger.
 *
 * No node: imports here on purpose. Stage 3 calls recordOccurrenceStarted from
 * inside a workflow step, and a step bundle runs in an isolate without the node
 * builtins a top-level import would pull in.
 */

/** Every terminal decision that can be written against an occurrence. Constrained
 *  by schedule_occurrences_outcome_check, so adding one here alone is not enough.
 *
 *  There is deliberately no 'skipped_capacity'. Being at capacity is not a
 *  decision about the occurrence, it is a reason it has not run yet, so it is
 *  recorded by recordOccurrenceAtCapacity as an annotation on a pending row. */
export type ScheduleOccurrenceOutcome =
  | "started"
  | "skipped_overlap"
  | "skipped_stale"
  | "superseded"
  | "expired"
  | "cancelled"
  | "run_cancelled"
  | "error";

/** The subset a dispatcher may settle an occurrence with directly. 'superseded'
 *  and 'cancelled' are excluded: the first is written only by the losing half of
 *  an atomic replacement, the second only by pausing the schedule. */
export type ScheduleSkipOutcome = "skipped_overlap" | "skipped_stale";

/**
 * Everything the ledger needs to admit an occurrence.
 *
 * The definition version is pinned here and never re-read later: the occurrence
 * must run the graph it was admitted under, even if a deploy lands while it waits.
 *
 * droppedOlder and droppedOlderAtLeast come straight from the evaluator and are
 * stored verbatim. They matter most on the occurrence that DOES run: without them
 * a schedule that was down for four days records one started run and a dropped
 * count of zero, and the operator reads that as a healthy schedule.
 */
export interface AdmittedOccurrence {
  scheduleId: string;
  occurrenceAt: Date;
  definitionId: number;
  definitionVersion: number;
  /** Occurrences older than this one that the evaluator passed over. */
  droppedOlder: number;
  /** True when droppedOlder is a floor, because the evaluator hit its cap. */
  droppedOlderAtLeast: boolean;
}

export type OccurrenceRow = typeof scheduleOccurrences.$inferSelect;

/**
 * Ceiling on how long a pending occurrence may wait before it is given up on.
 *
 * This is a guard against firing something very old, NOT a diagnosis. Reaching it
 * says only that this occurrence waited a day; it does not say the drain stopped,
 * and it must not be read that way. The expired row itself carries the facts that
 * tell those apart: attempt_count of zero means nothing ever tried it, and a
 * non-zero count with a skip_reason means attempts happened and failed.
 */
export const PENDING_OCCURRENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * How long a settled occurrence stays readable before it may be swept.
 *
 * Thirty days rather than a week, because for most of these rows this table is
 * the ONLY home. A started run can be reconstructed from workflow_runs, but
 * superseded, skipped_overlap, skipped_stale, expired, cancelled and error exist
 * nowhere else, and they are exactly what an operator asks about.
 */
const SETTLED_OCCURRENCE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Newest occurrences per schedule that retention never touches, whatever their
 * age. Without this floor a weekly schedule loses its entire visible history:
 * three successful runs, all older than the window, all swept, nothing left to
 * read. With it, every schedule always shows its recent past.
 */
const MIN_RETAINED_OCCURRENCES_PER_SCHEDULE = 20;

/**
 * The row is not settled, so a writer may still act on it.
 *
 * Settled is (pending = false AND outcome IS NOT NULL) and settled is terminal.
 * Spelled as the negation of that, with the pending branch first, because a
 * pending row carrying an 'error' outcome from a failed attempt is NOT settled and
 * the drain must still be able to retry and start it. Written as a positive
 * disjunction rather than NOT (...) so no branch can evaluate to NULL and quietly
 * fail the whole WHERE clause.
 */
const notSettled = sql`(${scheduleOccurrences.pending} = true
  OR ${scheduleOccurrences.outcome} IS NULL)`;

/**
 * Admit one occurrence.
 *
 * It takes the pending slot when the slot is free. When another occurrence of the
 * same schedule is already waiting, this one is inserted ALREADY SETTLED as
 * skipped_overlap, with the blocking occurrence's instant in skip_reason. The
 * partial unique index is on pending = true, so a settled insert cannot violate
 * it, and that is what turns what would be a silent hole in the ledger into a
 * readable row without a second table or a webhook-style rejection counter.
 *
 * The conflict clause is TARGETED at the primary key. A bare ON CONFLICT DO
 * NOTHING arbitrates over every unique index on the table, so a genuine race for
 * the pending slot would be swallowed as "already admitted" instead of retried.
 * That race is real (two evaluators can both see a free slot), so it is caught as
 * 23505 and the retry then sees the winner and settles behind it.
 *
 * Returns admitted: true ONLY to the caller whose insert took the pending slot.
 * That caller alone owns the dispatch. A re-evaluation of an occurrence that
 * already exists returns admitted: false with the stored row, so a repeated
 * evaluation replays the first decision rather than acting on it again.
 */
export async function acceptOccurrence(
  db: Db,
  admitted: AdmittedOccurrence,
): Promise<{ admitted: boolean; stored: OccurrenceRow }> {
  let took = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await db.execute(sql`
        WITH blocker AS (
          SELECT occ.occurrence_at
          FROM ${scheduleOccurrences} occ
          WHERE occ.schedule_id = ${admitted.scheduleId}
            AND occ.pending = true
          LIMIT 1
        )
        INSERT INTO ${scheduleOccurrences} (
          schedule_id, occurrence_at, definition_id, definition_version,
          pending, outcome, skip_reason, dropped_count, dropped_count_capped
        )
        SELECT ${admitted.scheduleId},
               ${admitted.occurrenceAt},
               ${admitted.definitionId},
               ${admitted.definitionVersion},
               NOT EXISTS (SELECT 1 FROM blocker),
               CASE WHEN EXISTS (SELECT 1 FROM blocker) THEN 'skipped_overlap' END,
               -- Formatted explicitly as UTC rather than cast with ::text, which
               -- renders in the session time zone and would make the stored reason
               -- depend on whichever connection happened to write it.
               (SELECT 'overlap:' || to_char(
                  b.occurrence_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS"Z"'
                ) FROM blocker b),
               ${admitted.droppedOlder},
               ${admitted.droppedOlderAtLeast}
        ON CONFLICT (schedule_id, occurrence_at) DO NOTHING
        RETURNING pending
      `);
      const rows = rawRows<{ pending: boolean }>(result);
      // One row back means this call inserted, and pending tells whether it took
      // the slot or landed already settled behind the occurrence that holds it.
      took = rows.length === 1 && rows[0]?.pending === true;
      break;
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === 1) throw error;
    }
  }
  const stored = await getOccurrence(db, admitted.scheduleId, admitted.occurrenceAt);
  if (!stored) throw new Error("schedule occurrence disappeared after admission");
  return { admitted: took, stored };
}

/**
 * The queue policy: keep at most one occurrence waiting, and make it the NEWEST.
 *
 * One statement, so the schedule is never briefly holding two pending
 * occurrences (which the partial unique index would refuse) and never briefly
 * holding none (which would let a concurrent evaluator admit a third).
 *
 * Returns admitted: true ONLY to the caller whose insert created the row, and
 * that caller alone owns the dispatch. Everyone else gets false plus the stored
 * row, exactly as acceptOccurrence behaves.
 *
 * The old pending occurrence is SETTLED as 'superseded', not mutated. None of the
 * existing coalescers can be copied here, and the reason is worth stating: both
 * webhook deliveries and provider trigger deliveries keep the old row's identity
 * and overwrite its mutable payload, which only works because the payload is not
 * the identity there. Here the occurrence instant IS the identity and there is no
 * payload at all (the inputs are the schedule's static task title and
 * description), so there is nothing to overwrite. Rewriting the old row's
 * occurrence_at would instead destroy the dedupe key that makes re-evaluation
 * safe, and the operator would lose the record that an occurrence was dropped.
 *
 * dropped_count carries the evaluator's own backlog count PLUS the superseded
 * row's, so a schedule that fell behind for an hour shows the true total on the
 * survivor, and dropped_count_capped stays set if either side was a floor.
 *
 * Only an occurrence STRICTLY NEWER than the one waiting may supersede it. An
 * out-of-order admission therefore does not quietly win the pending slot; it
 * collides with the one-pending index and surfaces to the caller, on the same
 * argument that keeps the conflict clause targeted in acceptOccurrence. The
 * evaluator admits occurrences in increasing order because the watermark only
 * moves forward, so an older admission means a bug or a manual replay, and both
 * deserve to be loud rather than silently firing a stale occurrence in
 * preference to the current one.
 *
 * The 23505 retry mirrors the webhook coalescer: two evaluators can still race,
 * one loses on the pending index, and the retry then sees the winner's row. If
 * the budget is exhausted the violation propagates, and callers must read it as
 * "another evaluator won this pass", NOT as "dispatch failed": nothing has been
 * dispatched, the winner owns the pending slot, and the correct response is to
 * do nothing rather than to retry or to report an error against the schedule.
 */
export async function supersedePendingThenAccept(
  db: Db,
  admitted: AdmittedOccurrence,
): Promise<{ admitted: boolean; stored: OccurrenceRow }> {
  let took = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await db.execute(sql`
        WITH superseded AS (
          UPDATE ${scheduleOccurrences} occ
          SET outcome = 'superseded',
              pending = false,
              updated_at = now()
          WHERE occ.schedule_id = ${admitted.scheduleId}
            AND occ.pending = true
            AND occ.occurrence_at < ${admitted.occurrenceAt}
          RETURNING occ.dropped_count, occ.dropped_count_capped
        )
        INSERT INTO ${scheduleOccurrences} (
          schedule_id, occurrence_at, definition_id, definition_version,
          pending, dropped_count, dropped_count_capped
        )
        SELECT ${admitted.scheduleId},
               ${admitted.occurrenceAt},
               ${admitted.definitionId},
               ${admitted.definitionVersion},
               true,
               -- LOAD-BEARING, DO NOT SIMPLIFY. These aggregates are not merely
               -- how the dropped counters are computed, they are what ORDERS the
               -- two sub-statements. The row cannot be formed until the SubPlan is
               -- evaluated, evaluating it drains the CteScan, and draining that
               -- runs the settling UPDATE's ModifyTable to completion.
               -- Data-modifying CTEs are otherwise unordered by definition.
               -- Replacing them with constants was measured on Postgres 17.9: the
               -- INSERT then runs first and dies with 23505 on the one-pending
               -- index, because the old row is still pending when the new one
               -- lands. Beware that our own suite does NOT reproduce that: on
               -- PGlite the same mutation raises no error and is caught only
               -- indirectly, by the dropped_count assertions. So a green suite is
               -- not evidence that these subqueries are redundant.
               ${admitted.droppedOlder}
                 + (SELECT count(*) + coalesce(sum(dropped_count), 0) FROM superseded),
               ${admitted.droppedOlderAtLeast}
                 OR (SELECT coalesce(bool_or(dropped_count_capped), false) FROM superseded)
        ON CONFLICT (schedule_id, occurrence_at) DO NOTHING
        RETURNING schedule_id
      `);
      // Under ON CONFLICT DO NOTHING, RETURNING yields a row only for an insert
      // that actually happened. That makes this an admission token earned by THIS
      // call, which is the whole point: computing it from the row we read back
      // instead would hand the same occurrence to every concurrent caller, since
      // all of them observe the one surviving pending row and none of them get an
      // error. Eight of them would then each dispatch a 3 to 25 minute agent run.
      took = rawRows(result).length === 1;
      break;
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === 1) throw error;
    }
  }
  const stored = await getOccurrence(db, admitted.scheduleId, admitted.occurrenceAt);
  if (!stored) throw new Error("schedule occurrence disappeared after supersede");
  return { admitted: took, stored };
}

/**
 * Publish the start, release the pending slot, and record the firing on the
 * schedule row, in one statement.
 *
 * Two writers call this for the same run: the dispatcher once start() returns,
 * and the winning workflow itself once it binds the owner. Either one alone is
 * enough, which is what closes the crash window between the hosted start and the
 * dispatcher-side write: a live run can never be left with a pending occurrence
 * for the drain to start a second time.
 *
 * Only an UNSETTLED occurrence may be started, plus the same run publishing again
 * (idempotence for the second writer). Every settled outcome is terminal, so a
 * cancelled, expired or superseded occurrence can never be turned into a run,
 * which is what makes pausing a schedule an actual stop rather than a delay.
 *
 * A consequence the caller must be ready for: this can return false AFTER the run
 * has already been started, when the occurrence was settled in between (a pause
 * is the realistic case). That is the existing orphaned-start path, the one
 * recordAndCancelOrphanStartedRun in lib/run-start-lifecycle.ts handles, and the
 * honest answer here is false rather than a start written over a cancellation.
 *
 * First start wins. A second run id cannot overwrite a published start, so the
 * pair is idempotent for the same run and exclusive across different ones, and
 * dispatched_at keeps the first writer's instant rather than being pushed later
 * by the second.
 *
 * The ownership guard is on owner_token alone rather than on a subject key, which
 * is the one place this deliberately differs from the webhook version, and the
 * residual is worth saying out loud: the EXISTS identifies the RESERVATION, not
 * the subject. It matches a live reservation under that token on ANY subject, so
 * the caller must pass the token from the reservation it made for THIS
 * occurrence. That is safe rather than lucky, because a token is minted per
 * reservation as `owner:${randomUUID()}` (lib/dispatch.ts:163) and a rebind
 * replaces the token on the subject's single row, so one token names one
 * reservation. The table is bounded by run concurrency, so scanning it by token
 * is free.
 *
 * The state half of the predicate is a fence, not decoration: it admits only a
 * pre-start reservation or this run's own bound row, so a subject that has moved
 * to cancelling, parking or parked can no longer have a start published against
 * it. That is the same boundary assertActiveRunOwner defends before an
 * irreversible provider call (lib/active-run-owner.ts:13-18).
 *
 * The schedule-row write is what a UI should render as "last run". It is kept
 * monotonic so a late publication for an older occurrence cannot rewind it, and
 * it outlives the ledger's retention window, which is the only reason a schedule
 * that last ran a year ago can still say so.
 */
export async function recordOccurrenceStarted(
  db: Pick<Db, "execute">,
  scheduleId: string,
  occurrenceAt: Date,
  ownerToken: string,
  runId: string,
): Promise<boolean> {
  // Deliberately NOT aliased. Aliasing the target in an UPDATE hides the real
  // table name, and the shared notSettled predicate is built from the drizzle
  // column objects, which render as "schedule_occurrences"."pending". One alias
  // here would silently make that predicate unresolvable.
  const updated = await db.execute(sql`
    WITH published AS (
      UPDATE ${scheduleOccurrences}
      SET outcome = 'started',
          pending = false,
          run_id = ${runId},
          dispatched_at = coalesce(${scheduleOccurrences.dispatchedAt}, now()),
          updated_at = now()
      WHERE ${scheduleOccurrences.scheduleId} = ${scheduleId}
        AND ${scheduleOccurrences.occurrenceAt} = ${occurrenceAt}
        AND (
          ${notSettled}
          OR (
            ${scheduleOccurrences.outcome} = 'started'
            AND ${scheduleOccurrences.runId} = ${runId}
          )
        )
        AND EXISTS (
          SELECT 1 FROM ${activeRuns}
          WHERE ${activeRuns.ownerToken} = ${ownerToken}
            AND (
              (${activeRuns.state} = 'reserved' AND ${activeRuns.runId} IS NULL)
              OR (${activeRuns.state} = 'bound' AND ${activeRuns.runId} = ${runId})
            )
        )
      RETURNING ${scheduleOccurrences.scheduleId}, ${scheduleOccurrences.occurrenceAt}
    ), fired AS (
      UPDATE ${workflowSchedules} s
      SET last_started_occurrence_at = published.occurrence_at,
          last_started_run_id = ${runId},
          updated_at = now()
      FROM published
      WHERE s.id = published.schedule_id
        AND (
          s.last_started_occurrence_at IS NULL
          OR s.last_started_occurrence_at <= published.occurrence_at
        )
      RETURNING s.id
    )
    SELECT occurrence_at FROM published
  `);
  return rawRows(updated).length === 1;
}

/**
 * Flip a started occurrence to run_cancelled when a human cancels its run in
 * flight. The schedule-specific half of run cancellation: the always-layer has
 * already blocked the run in workflow_runs, and this records, in the ledger the
 * operator reads, that an occurrence which DID start was cancelled by hand,
 * distinct from 'cancelled' (an occurrence that never started because its
 * schedule was paused or revoked) and from the skip and expiry outcomes the
 * system settles itself.
 *
 * Keyed by run_id, which the run_id index makes cheap. Returns whether a started
 * occurrence was flipped. A no-op (false) when no started occurrence carries that
 * run_id: a webhook or manual run has no occurrence, and an occurrence already
 * settled into any other outcome is out of scope.
 *
 * WINDOW. A run becomes cancellable-by-id the moment bindWorkflowCandidateStep
 * writes active_runs.run_id, several steps before acknowledgeScheduleDispatchStep
 * (or the dispatcher's post-claim recordStarted) publishes 'started' and the
 * occurrence's run_id. A cancel that lands in that bind-to-started window finds no
 * started row and no-ops here: the occurrence stays pending and the drain may
 * re-dispatch it. This is tolerated, not prevented, because every operator surface
 * that hands out a runId exists only after 'started': the workflow_runs row behind
 * the runs list is written by recordBlockStatuses inside the body, after the
 * acknowledge steps, and last_started_run_id is written by recordStarted. So a
 * UI-driven cancel cannot reach the window; only an out-of-band runId can. The
 * caller warn-logs a false return on a schedule subject so the miss is observed,
 * and the re-dispatch self-remedies (the new run is visible and cancellable
 * normally). Do NOT add a subjectKey/pending fallback to close this: settling a
 * pending occurrence risks flipping the WRONG occurrence (a skip/queue schedule
 * whose in-flight run already expired, leaving a newer occurrence pending), which
 * is permanent ledger corruption, strictly worse than a self-remedying no-op.
 *
 * INVARIANT EXCEPTION. A 'started' row is SETTLED (pending = false, outcome not
 * null), and settled is terminal everywhere else in this file (see the header and
 * the notSettled guard): nothing may reopen it. This is the one and only writer
 * that mutates a settled occurrence. Do not generalise it to touch any other
 * outcome. skip_reason is deliberately left as-is: the reason an occurrence
 * started is not the reason its run was cancelled.
 */
export async function settleScheduleOccurrenceOnCancel(
  db: Db,
  runId: string,
): Promise<boolean> {
  const flipped = await db
    .update(scheduleOccurrences)
    .set({
      outcome: "run_cancelled",
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(scheduleOccurrences.runId, runId),
        eq(scheduleOccurrences.outcome, "started"),
      ),
    )
    .returning({ occurrenceAt: scheduleOccurrences.occurrenceAt });
  return flipped.length > 0;
}

/**
 * Settle an occurrence that will not run. Releases the pending slot, because a
 * skip is a decision and not a deferral: the next occurrence is the schedule's
 * next chance, not this one.
 *
 * blockingRunId names the run that held the subject for an overlap skip, so an
 * operator reading the ledger can see WHY it was skipped and not merely that it
 * was. Returns false when no such occurrence exists or it was already settled,
 * which is a caller bug rather than a routine outcome: the previous silent void
 * return let a write against a wrong key look like a success.
 */
export async function recordOccurrenceSkipped(
  db: Db,
  scheduleId: string,
  occurrenceAt: Date,
  outcome: ScheduleSkipOutcome,
  options: {
    skipReason?: string;
    blockingRunId?: string;
  } = {},
): Promise<boolean> {
  const rows = await db
    .update(scheduleOccurrences)
    .set({
      outcome,
      pending: false,
      // Never clears an existing reason. A skip that arrives after two failed
      // attempts must not erase the provider message that explains them, or the
      // operator reads "skipped_overlap" and goes looking for an overlap that was
      // never the problem.
      skipReason: sql`coalesce(${options.skipReason ?? null}, ${scheduleOccurrences.skipReason})`,
      blockingRunId: options.blockingRunId ?? null,
      updatedAt: sql`now()`,
    })
    .where(and(occurrenceIs(scheduleId, occurrenceAt), notSettled))
    .returning({ scheduleId: scheduleOccurrences.scheduleId });
  return rows.length === 1;
}

/**
 * Record a failed dispatch attempt WITHOUT releasing the pending slot: the
 * occurrence still deserves to run, nothing external will re-deliver it, and the
 * drain is the only thing that can retry it. expirePendingOccurrences is the
 * backstop for one that never succeeds.
 *
 * The row stays pending, so it is NOT settled and remains startable. attempt_count
 * is what survives the retries: the message here is overwritten by the next
 * failure, so one text column plus a counter is the whole story, and
 * attempt_count > 1 is the operator's signal to go and read the logs.
 */
export async function recordOccurrenceError(
  db: Db,
  scheduleId: string,
  occurrenceAt: Date,
  message: string,
): Promise<boolean> {
  const rows = await db
    .update(scheduleOccurrences)
    .set({
      outcome: "error",
      skipReason: message,
      attemptCount: sql`${scheduleOccurrences.attemptCount} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(occurrenceIs(scheduleId, occurrenceAt), notSettled))
    .returning({ scheduleId: scheduleOccurrences.scheduleId });
  return rows.length === 1;
}

/**
 * Note that this occurrence could not start because the system is at capacity.
 *
 * NOT a settlement. The occurrence stays pending with no outcome, so the drain
 * tries it again on the next tick. Settling it would break the queue policy's
 * central promise (the customer chose "wait", so it waits) and would turn a
 * transient shortage into a silently abandoned run. The operator sees "waiting,
 * four attempts" instead of "skipped".
 */
export async function recordOccurrenceAtCapacity(
  db: Db,
  scheduleId: string,
  occurrenceAt: Date,
): Promise<boolean> {
  const rows = await db
    .update(scheduleOccurrences)
    .set({
      skipReason: "at_capacity",
      attemptCount: sql`${scheduleOccurrences.attemptCount} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        occurrenceIs(scheduleId, occurrenceAt),
        eq(scheduleOccurrences.pending, true),
      ),
    )
    .returning({ scheduleId: scheduleOccurrences.scheduleId });
  return rows.length === 1;
}

/**
 * Settle pending occurrences that have waited past the age ceiling, so a schedule
 * whose drain stalled does not hold its pending slot forever and block every
 * later occurrence.
 *
 * The age is measured from created_at (how long it has been waiting), not from
 * occurrence_at (how old the instant is). A catch-up deliberately admits an
 * occurrence whose instant is already old, and that occurrence must still get its
 * turn at the drain; whether an old instant deserves to fire at all is the
 * evaluator's catch-up grace decision, recorded as skipped_stale.
 *
 * skip_reason is coalesced, so an occurrence that failed repeatedly keeps the last
 * provider message and the operator can still see why it never got anywhere.
 *
 * Returns how many were expired, which is the number worth logging.
 */
export async function expirePendingOccurrences(
  db: Db,
  now: Date = new Date(),
  maxAgeMs: number = PENDING_OCCURRENCE_MAX_AGE_MS,
): Promise<number> {
  const rows = await db
    .update(scheduleOccurrences)
    .set({
      outcome: "expired",
      pending: false,
      skipReason: sql`coalesce(${scheduleOccurrences.skipReason}, 'expired_before_dispatch')`,
      updatedAt: sql`now()`,
    })
    // No settled-guard needed: pending = true IS the unsettled half, and a
    // published start clears pending in the same statement that sets it.
    .where(
      and(
        eq(scheduleOccurrences.pending, true),
        lt(scheduleOccurrences.createdAt, new Date(now.getTime() - maxAgeMs)),
      ),
    )
    .returning({ scheduleId: scheduleOccurrences.scheduleId });
  return rows.length;
}

export async function getOccurrence(
  db: Db,
  scheduleId: string,
  occurrenceAt: Date,
): Promise<OccurrenceRow | null> {
  const rows = await db
    .select()
    .from(scheduleOccurrences)
    .where(occurrenceIs(scheduleId, occurrenceAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * One schedule's recent ledger, newest first, for an editor or a status panel.
 *
 * The only other reads are by exact instant and the drain's pending list, so
 * without this a caller wanting "what has this schedule been doing" has to guess
 * an instant, and guessing the watermark returns at most one row and often none.
 */
export async function listOccurrencesForSchedule(
  db: Db,
  scheduleId: string,
  limit: number,
): Promise<OccurrenceRow[]> {
  return await db
    .select()
    .from(scheduleOccurrences)
    .where(eq(scheduleOccurrences.scheduleId, scheduleId))
    .orderBy(desc(scheduleOccurrences.occurrenceAt))
    .limit(limit);
}

/**
 * Oldest pending occurrences across schedules, bounded, for the drain. One
 * pending row per schedule means this is already one entry per waiting schedule.
 *
 * Joined to the schedule so a paused or revoked one contributes nothing. Without
 * that join, pausing a schedule would still let the drain pick up whatever it had
 * waiting, which is the same leak pauseSchedule closes from the other side: the
 * pause cancels the pending row, and this refuses to serve one even if a race
 * left it behind.
 *
 * Oldest first with a limit, so a backlog is served in occurrence order and the
 * tail waits for the next pass: fair, but head-of-line blocking is real if the
 * oldest schedules keep failing to start.
 */
export async function listPendingOccurrences(
  db: Db,
  limit: number,
): Promise<OccurrenceRow[]> {
  return await db
    .select(getTableColumns(scheduleOccurrences))
    .from(scheduleOccurrences)
    .innerJoin(
      workflowSchedules,
      eq(workflowSchedules.id, scheduleOccurrences.scheduleId),
    )
    .where(
      and(
        eq(scheduleOccurrences.pending, true),
        isNull(workflowSchedules.pausedAt),
        isNull(workflowSchedules.revokedAt),
      ),
    )
    .orderBy(asc(scheduleOccurrences.occurrenceAt))
    .limit(limit);
}

/**
 * Drop settled occurrences that are both past the retention window AND outside
 * their schedule's newest MIN_RETAINED_OCCURRENCES_PER_SCHEDULE rows.
 *
 * Both conditions, which is the point. Age alone would empty a weekly schedule's
 * history completely, since every row it has is older than the window long before
 * there are many of them, and for most outcomes this table is the only record
 * that exists. The floor is per schedule, so a busy schedule is still trimmed.
 *
 * A pending row is never swept whatever its age: it is still waiting for its
 * schedule's subject, for capacity, or for a retry, so deleting it would strand
 * work the drain still owns, and worse, deleting the dedupe key would let the same
 * occurrence be admitted and dispatched a second time. Pending growth is bounded
 * by expirePendingOccurrences instead.
 */
export async function sweepSettledOccurrences(
  db: Db,
  now: Date = new Date(),
): Promise<void> {
  const cutoff = new Date(now.getTime() - SETTLED_OCCURRENCE_RETENTION_MS);
  await db.execute(sql`
    DELETE FROM ${scheduleOccurrences} occ
    USING (
      SELECT schedule_id,
             occurrence_at,
             row_number() OVER (
               PARTITION BY schedule_id ORDER BY occurrence_at DESC
             ) AS rn
      FROM ${scheduleOccurrences}
    ) ranked
    WHERE occ.schedule_id = ranked.schedule_id
      AND occ.occurrence_at = ranked.occurrence_at
      AND ranked.rn > ${MIN_RETAINED_OCCURRENCES_PER_SCHEDULE}
      AND occ.pending = false
      AND occ.outcome IS NOT NULL
      AND occ.created_at < ${cutoff}
  `);
}

function occurrenceIs(scheduleId: string, occurrenceAt: Date) {
  return and(
    eq(scheduleOccurrences.scheduleId, scheduleId),
    eq(scheduleOccurrences.occurrenceAt, occurrenceAt),
  );
}

function rawRows<T = { scheduleId: string }>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

/**
 * A unique violation, which for this table means the one-pending-per-schedule
 * index refused a second waiting occurrence. Callers read this to tell that
 * collision apart from a real failure.
 *
 * The chain walk is required, not defensive: drizzle wraps a driver error in its
 * own query error and hangs the original off `cause`, so the SQLSTATE is not on
 * the error the caller catches. Depth is capped because a cause chain is
 * attacker-independent but still worth not trusting to be acyclic.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth += 1) {
    if (
      typeof current === "object" &&
      "code" in current &&
      (current as { code?: string }).code === "23505"
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
