import { start } from "workflow/api";
import { env } from "../../env.js";
import type { Db } from "../db/client.js";
import type {
  RunRegistryAdapter,
  StartedRunRecord,
} from "../adapters/run-registry/types.js";
import type { AgentWorkflowInput } from "../workflows/agent-input.js";
import { agentWorkflow } from "../workflows/agent.js";
import { claimSubjectRun, envTriggerRateLimitDefault } from "../lib/dispatch.js";
import { logger } from "../lib/logger.js";
import {
  enforceTriggerRateLimit,
  resolveTriggerRateLimit,
  triggerRateLimitLogFields,
  type TriggerRateLimitConfig,
  type TriggerRateLimitDecision,
  type TriggerRateLimitKey,
  type TriggerRateLimitNodeParams,
} from "../lib/trigger-rate-limit.js";
import { getLiveScheduleTriggerTarget } from "../workflow-definition/store.js";
import { scheduleSubjectKey } from "../lib/subject-key.js";
import { dueOccurrence } from "./occurrence.js";
import {
  cancelWaitingOccurrences,
  REVOKED_SCHEDULE_REASON,
} from "./revoked-occurrences.js";
import {
  acceptOccurrence,
  expirePendingOccurrences,
  isUniqueViolation,
  listPendingOccurrences,
  recordOccurrenceAtCapacity,
  recordOccurrenceError,
  recordOccurrenceSkipped,
  recordOccurrenceStarted,
  supersedePendingThenAccept,
  sweepSettledOccurrences,
  type AdmittedOccurrence,
  type OccurrenceRow,
  type ScheduleSkipOutcome,
} from "./occurrence-store.js";
import {
  advanceWatermark,
  getScheduleById,
  listEvaluableSchedules,
  recordEvaluationPass,
  revokeSchedule,
  type ScheduleOverlapPolicy,
  type ScheduleRow,
} from "./schedule-store.js";

/**
 * Turns a due schedule occurrence into a run.
 *
 * Everything the dispatcher needs is injected, which is not ceremony: the only
 * defects this module can have are wrong store call, wrong subject shape, and
 * acting without an admission token, and all three are invisible unless the test
 * can watch which port was called with what.
 */

/** Ledger writes, one method per decision the dispatcher can record. Bound to a
 *  database by the factory below. */
export interface ScheduleOccurrenceLedgerPort {
  accept(
    admitted: AdmittedOccurrence,
  ): Promise<{ admitted: boolean; stored: OccurrenceRow }>;
  supersedeThenAccept(
    admitted: AdmittedOccurrence,
  ): Promise<{ admitted: boolean; stored: OccurrenceRow }>;
  recordStarted(
    scheduleId: string,
    occurrenceAt: Date,
    ownerToken: string,
    runId: string,
  ): Promise<boolean>;
  recordSkipped(
    scheduleId: string,
    occurrenceAt: Date,
    outcome: ScheduleSkipOutcome,
    options?: { skipReason?: string; blockingRunId?: string },
  ): Promise<boolean>;
  recordError(
    scheduleId: string,
    occurrenceAt: Date,
    message: string,
  ): Promise<boolean>;
  recordAtCapacity(scheduleId: string, occurrenceAt: Date): Promise<boolean>;
  /** Settle whatever this schedule left waiting, for a revocation. Separate from
   *  recordSkipped because 'cancelled' is not a skip outcome a dispatcher may
   *  choose, and the frozen store writes it only from pauseSchedule. */
  cancelWaiting(scheduleId: string, reason: string): Promise<number>;
  listPending(limit: number): Promise<OccurrenceRow[]>;
  expirePending(now: Date): Promise<number>;
  sweepSettled(now: Date): Promise<void>;
}

/** Schedule-row reads and the two cursor writes an evaluation pass performs. */
export interface ScheduleRowPort {
  listEvaluable(limit: number): Promise<ScheduleRow[]>;
  recordEvaluationPass(scheduleId: string, now: Date): Promise<void>;
  advanceWatermark(scheduleId: string, occurrenceAt: Date): Promise<boolean>;
  revoke(scheduleId: string, now: Date): Promise<void>;
  getById(scheduleId: string): Promise<ScheduleRow | null>;
}

/** What the graph still says about a schedule's node, re-read every tick. */
export interface LiveScheduleTarget {
  /** Version the run must execute: the occurrence's pin when it has one, the
   *  deployed head otherwise. */
  definitionVersion: number;
  taskTitle: string;
  taskDescription: string;
  /** Start budget authored on the node. Absent keys mean the env default
   *  decides, and no default means unlimited. */
  rateLimit?: TriggerRateLimitNodeParams;
}

export interface ScheduleTargetQuery {
  definitionId: number;
  nodeId: string;
  /** Version an already-admitted occurrence is pinned to, null while evaluating. */
  definitionVersion: number | null;
}

export interface ScheduleDispatchDeps {
  runRegistry: RunRegistryAdapter;
  maxConcurrentAgents: number;
  occurrences: ScheduleOccurrenceLedgerPort;
  schedules: ScheduleRowPort;
  /**
   * Liveness, fail-closed: null means this schedule's node is no longer part of
   * an enabled definition's deployed head and the row must be revoked. Injected
   * rather than imported so this module does not depend on how definitions are
   * stored.
   */
  resolveScheduleTarget(
    query: ScheduleTargetQuery,
  ): Promise<LiveScheduleTarget | null>;
  /**
   * Count one start against this schedule node's trigger rate limit and answer
   * whether it may proceed, or null when the node is unlimited (in which case
   * nothing is written). Injected like every other write this module performs,
   * so a test can watch the decision without a database.
   */
  consumeTriggerRateLimit(
    key: TriggerRateLimitKey,
    config: TriggerRateLimitConfig,
    now: Date,
  ): Promise<TriggerRateLimitDecision | null>;
  startWorkflow(input: AgentWorkflowInput): Promise<string>;
  /** Cancels a run that started for an occurrence which was settled underneath
   *  it. The existing orphaned-start path, not a second one. */
  orphanStartedRun(started: StartedRunRecord): Promise<void>;
  /**
   * Pull requests the schedule's previous run opened.
   *
   * Every occurrence branches from the default branch under its own identity, so
   * without this the run has no way to know the last one already opened a pull
   * request nobody merged, and a daily "keep the changelog current" schedule
   * produces fourteen mutually conflicting duplicates in a fortnight. Handed to
   * the agent as context so it can recognise its own outstanding work.
   */
  previousRunPullRequests(runId: string): Promise<string[]>;
  now(): Date;
}

export interface ScheduleOccurrenceDispatch {
  scheduleId: string;
  occurrenceAt: Date;
  definitionId: number;
  definitionVersion: number;
  nodeId: string;
  overlapPolicy: ScheduleOverlapPolicy;
  taskTitle: string;
  taskDescription: string;
  /** Start budget authored on the schedule's node, carried from the live target
   *  so the check uses the graph this occurrence was resolved against. */
  rateLimit?: TriggerRateLimitNodeParams;
  /** Occurrence this schedule last started a run for, so the task instruction can
   *  be written relative to it. Null on the first firing. */
  previousOccurrenceAt: Date | null;
  /** Pull request URLs the previous run opened, so this one can recognise work of
   *  its own that is still waiting for a human. */
  previousRunPullRequests: string[];
  droppedOlder: number;
  droppedOlderAtLeast: boolean;
}

export type DispatchScheduleResult =
  | { result: "started"; runId: string }
  | { result: "skipped_overlap"; blockingRunId: string | null }
  | { result: "queued" }
  | { result: "at_capacity" }
  | { result: "not_admitted" }
  | { result: "orphaned_start"; runId: string }
  /** The ledger write itself failed, so NOTHING exists for this occurrence. Kept
   *  apart from "error" because the caller must not advance the watermark past an
   *  occurrence it has no record of: that is the one way an occurrence can vanish
   *  with no row and no second chance. */
  | { result: "not_recorded"; reason: string }
  | { result: "error"; reason: string };

/**
 * Admit one occurrence and start its run.
 *
 * ONE rule decides all three overlap policies: a LIVE RUN blocks an occurrence,
 * a waiting ledger row does not. So admission always supersedes whatever is
 * waiting (see AdmissionMode), and the policies differ only in what happens when
 * the schedule's subject is held by a run that has actually started:
 *   - skip settles the occurrence as skipped_overlap, naming that run;
 *   - queue leaves it pending, so the drain starts it once the subject frees;
 *   - allow never collides, because its subject carries the occurrence instant.
 *
 * A residual worth knowing: the ledger keeps at most ONE pending occurrence per
 * schedule, so a backlog can never be more than one deep under any policy. Under
 * allow that is visible as two occurrences never waiting side by side, only
 * running side by side. It costs nothing until the whole system is at capacity,
 * which is the only way an occurrence waits at all.
 */
export async function dispatchScheduleOccurrence(
  occurrence: ScheduleOccurrenceDispatch,
  deps: ScheduleDispatchDeps,
): Promise<DispatchScheduleResult> {
  const admission = await admitOccurrence(
    {
      scheduleId: occurrence.scheduleId,
      occurrenceAt: occurrence.occurrenceAt,
      definitionId: occurrence.definitionId,
      definitionVersion: occurrence.definitionVersion,
      droppedOlder: occurrence.droppedOlder,
      droppedOlderAtLeast: occurrence.droppedOlderAtLeast,
    },
    "supersede",
    deps,
  );
  if (!admission.ok) return admission.failure;

  // The insert token, not the row we can see. Every concurrent evaluator
  // observes the same surviving pending row, so deriving ownership from it would
  // hand one occurrence to all of them and start one long agent run each.
  if (!admission.result.admitted) {
    // The store may have inserted this occurrence already settled behind the one
    // holding the pending slot. Reading that back is reporting, never a licence
    // to dispatch.
    const stored = admission.result.stored;
    return stored.outcome === "skipped_overlap"
      ? { result: "skipped_overlap", blockingRunId: stored.blockingRunId }
      : { result: "not_admitted" };
  }

  return startAdmittedOccurrence(occurrence, deps, "settle");
}

/**
 * How a due occurrence enters the ledger when another one is already waiting.
 *
 * "supersede" is the answer for EVERY overlap policy, and the reason is that a
 * waiting row is not a running job. A pending occurrence that never started is
 * work the system owes and has not delivered, so a newer occurrence replacing it
 * loses nothing: what a schedule wants is the freshest run, not the oldest queued
 * intention. Admitting behind it instead produced two days of a daily schedule
 * with zero runs, the second occurrence reading "skipped_overlap: the previous
 * run was still going" when no run had ever started.
 *
 * "behind" exists for the stale path only: an occurrence past its grace will
 * never run, so evicting a live pending one in its favour trades something for
 * nothing.
 */
type AdmissionMode = "supersede" | "behind";

/**
 * Write the occurrence into the ledger, translating the two failures that are
 * not the schedule's fault.
 *
 * Shared by the due and the stale paths, because "another evaluator won the
 * pending slot" reads identically on both and a raised 23505 must never be
 * reported as a schedule failure: nothing was dispatched and the winner owns the
 * occurrence, so the correct response is to do nothing.
 */
async function admitOccurrence(
  admission: AdmittedOccurrence,
  mode: AdmissionMode,
  deps: ScheduleDispatchDeps,
): Promise<
  | { ok: true; result: { admitted: boolean; stored: OccurrenceRow } }
  | { ok: false; failure: DispatchScheduleResult }
> {
  try {
    return {
      ok: true,
      result:
        mode === "supersede"
          ? await deps.occurrences.supersedeThenAccept(admission)
          : await deps.occurrences.accept(admission),
    };
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: false, failure: { result: "not_admitted" } };
    }
    const reason = error instanceof Error ? error.message : String(error);
    // Logged, not just counted. Nothing durable exists for this occurrence, so
    // this line is the only trace an operator will ever have of it, and a bare
    // metric leaves them with an error count and no way to reach the cause.
    logger.warn(
      {
        scheduleId: admission.scheduleId,
        occurrenceAt: admission.occurrenceAt.toISOString(),
        err: reason,
      },
      "schedule_occurrence_admission_failed",
    );
    return { ok: false, failure: { result: "not_recorded", reason } };
  }
}

/**
 * Whether an occurrence that finds its subject claimed may be settled here.
 *
 * "retry" is unconditional for the drain, which reads a pending row that is not
 * exclusive to it. "settle" is NOT a guarantee of exclusivity, only of not being
 * the drain: an admission token is exclusive against other evaluators, but the
 * row it creates is visible to the drain of an overlapping poll invocation the
 * moment it commits. So the settle path still has to check who holds the subject
 * before it decides, and that check lives in startAdmittedOccurrence.
 */
type OverlapResolution = "settle" | "retry";

async function startAdmittedOccurrence(
  occurrence: ScheduleOccurrenceDispatch,
  deps: ScheduleDispatchDeps,
  onOverlap: OverlapResolution,
): Promise<DispatchScheduleResult> {
  const subjectKey = subjectKeyFor(occurrence);
  try {
    if (occurrence.overlapPolicy === "allow") {
      const blockingRunId = await inFlightCeilingBlocker(occurrence, deps);
      if (blockingRunId !== null) {
        // Same rule as an overlapped subject: the drain may not settle a row it
        // does not exclusively own.
        return onOverlap === "retry"
          ? { result: "queued" }
          : settleOverlap(
              occurrence,
              deps,
              blockingRunId,
              "overlap:in_flight_ceiling",
            );
      }
    }

    // Held in an object because the decision is produced inside the claim
    // callback but acted on after it returns.
    const budget: { spent: TriggerRateLimitDecision | null } = { spent: null };
    const dispatched = await claimSubjectRun(
      { subjectKey, ticketKey: null, kind: "schedule" },
      deps.runRegistry,
      deps.maxConcurrentAgents,
      {
        postClaimGuard: async () => {
          const decision = await consumeScheduleRateLimit(occurrence, deps);
          if (!decision || decision.allowed) return null;
          budget.spent = decision;
          return { started: false, reason: "rate_limited" };
        },
        startWorkflow: async (ownerToken) =>
          deps.startWorkflow(workflowInputFor(occurrence, subjectKey, ownerToken)),
      },
    );

    if (budget.spent) {
      logger.info(
        {
          scheduleId: occurrence.scheduleId,
          occurrenceAt: occurrence.occurrenceAt.toISOString(),
          triggerType: "trigger_schedule",
          nodeId: occurrence.nodeId,
          ...triggerRateLimitLogFields(budget.spent),
        },
        "trigger_rate_limited",
      );
      // Settled, never left pending, and this is the whole point: refused starts
      // are counted, so a pending occurrence the drain retried every minute would
      // keep its own window spent and never run. Skipping it is also what the
      // 'skip' overlap policy already promises for "not this time".
      await deps.occurrences.recordSkipped(
        occurrence.scheduleId,
        occurrence.occurrenceAt,
        "skipped_overlap",
        { skipReason: RATE_LIMITED_SKIP_REASON },
      );
      return { result: "skipped_overlap", blockingRunId: null };
    }

    if (dispatched.started) {
      const runId = dispatched.runId!;
      const published = await deps.occurrences.recordStarted(
        occurrence.scheduleId,
        occurrence.occurrenceAt,
        dispatched.ownerToken!,
        runId,
      );
      if (published) return { result: "started", runId };
      // The run exists but its occurrence was settled underneath it, realistically
      // by a pause. That is the existing orphaned-start shape, not a new one.
      await deps.orphanStartedRun({
        subjectKey,
        ticketKey: null,
        kind: "schedule",
        ownerToken: dispatched.ownerToken!,
        runId,
      });
      return { result: "orphaned_start", runId };
    }

    // Capacity is a resource, not a decision about this occurrence: it stays
    // pending under every policy, including skip, and the drain retries it. The
    // annotation only bumps the attempt counter so an operator can tell "nobody
    // tried it" from "it has been waiting for four passes".
    if (dispatched.reason === "at_capacity") {
      await deps.occurrences.recordAtCapacity(
        occurrence.scheduleId,
        occurrence.occurrenceAt,
      );
      return { result: "at_capacity" };
    }

    if (dispatched.reason === "already_claimed") {
      // The schedule's own subject is taken, which is the one condition the
      // overlap policy decides. Read WHO holds it before deciding, not after.
      //
      // A holder with no run id is a reservation, which means a concurrent
      // dispatcher of THIS occurrence, not a sibling run: the pending row an
      // evaluator just admitted is immediately visible to the drain of an
      // overlapping poll invocation, and the poll has no lock while the cron
      // fires every minute. Settling here would terminally skip the occurrence
      // the other pass is about to publish a start against, which then answers
      // false and cancels a healthy run, and the watermark has already moved so
      // the occurrence never fires at all. Stand down instead.
      //
      // queue chose to wait, so it stands down for any holder, and the row stays
      // pending exactly as it is with no annotation: nothing has gone wrong.
      const holder = await deps.runRegistry.get(subjectKey);
      if (
        onOverlap === "retry" ||
        occurrence.overlapPolicy === "queue" ||
        holder?.runId == null
      ) {
        return { result: "queued" };
      }
      // Reaching here means a real run holds the subject, so every skipped_overlap
      // THIS path writes names the run that blocked it. It is not the ledger's only
      // producer of that outcome: acceptOccurrence (occurrence-store.ts) inserts an
      // occurrence already settled as skipped_overlap behind one that was merely
      // still waiting, with no run to name and the blocking occurrence's instant in
      // skip_reason instead. That is why the editor reads blockingRunId before it
      // says "the previous run was still going".
      return settleOverlap(occurrence, deps, holder.runId);
    }

    return await persistRetryableFailure(
      occurrence,
      deps,
      `schedule claim failed: ${dispatched.reason ?? "unknown"}`,
    );
  } catch (error) {
    return await persistRetryableFailure(
      occurrence,
      deps,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Stop evaluating a schedule AND settle whatever it left waiting.
 *
 * pauseSchedule cancels the pending occurrence in the same statement; revocation
 * does not, and the asymmetry bites because a revocation is reversible: remove
 * the node at 09:05 while the 09:00 occurrence waits for capacity, restore it at
 * 20:00, and the deploy lifts the revocation onto a still-pending occurrence that
 * the drain then starts eleven hours late. Settling it here closes that, and
 * 'cancelled' rather than a skip is the honest word: a human removed the node.
 *
 * Not atomic with the revocation, and it does not need to be: revoking is a
 * deploy-time act, and an occurrence that survives a crash between the two is
 * refused by the drain's own grace window on the next tick.
 */
async function revokeAndCancelWaiting(
  scheduleId: string,
  deps: ScheduleDispatchDeps,
  now: Date,
): Promise<void> {
  await deps.schedules.revoke(scheduleId, now);
  await deps.occurrences.cancelWaiting(scheduleId, REVOKED_SCHEDULE_REASON);
}

/**
 * The skip_reason a rate-limited occurrence carries. The ledger's outcome stays
 * skipped_overlap (its enum is a database check constraint, and "settled without
 * a run, not replayed" is exactly what this is), so the reason is what tells an
 * operator a limit refused it rather than a sibling run. The editor reads this
 * string; the durable per-node tally lives in trigger_rejection_counters.
 */
export const RATE_LIMITED_SKIP_REASON = "rate_limited";

/**
 * Count this occurrence against the node's trigger rate limit. The schedule
 * dispatcher knows its own node, so the counter key is exact, and the node's own
 * params beat the env default.
 */
async function consumeScheduleRateLimit(
  occurrence: ScheduleOccurrenceDispatch,
  deps: ScheduleDispatchDeps,
): Promise<TriggerRateLimitDecision | null> {
  const config = resolveTriggerRateLimit(
    occurrence.rateLimit,
    envTriggerRateLimitDefault(env),
  );
  if (config === null) return null;
  return deps.consumeTriggerRateLimit(
    { definitionId: String(occurrence.definitionId), nodeId: occurrence.nodeId },
    config,
    deps.now(),
  );
}

/** Settle an occurrence that will not run because another run of this schedule
 *  holds its place, naming that run so the ledger says why. */
async function settleOverlap(
  occurrence: ScheduleOccurrenceDispatch,
  deps: ScheduleDispatchDeps,
  blockingRunId: string | null,
  skipReason?: string,
): Promise<DispatchScheduleResult> {
  await deps.occurrences.recordSkipped(
    occurrence.scheduleId,
    occurrence.occurrenceAt,
    "skipped_overlap",
    {
      ...(skipReason === undefined ? {} : { skipReason }),
      ...(blockingRunId === null ? {} : { blockingRunId }),
    },
  );
  return { result: "skipped_overlap", blockingRunId };
}

/**
 * How many of this schedule's occurrence runs may be live at once under 'allow'.
 *
 * 'allow' gives every occurrence its own subject, so nothing in the claim
 * protocol bounds them: a 25 minute run on a 15 minute schedule would accumulate
 * until the global agent pool was full of one customer's schedule. Two is enough
 * for the case 'allow' exists for, an occurrence outliving its period without
 * losing the next one.
 *
 * Two is a cap on one schedule, NOT a small share of the pool. At the default
 * MAX_CONCURRENT_AGENTS of three it is two thirds of everything the worker can
 * run, so one schedule under allow can be the majority tenant. What keeps that
 * survivable is ordering rather than arithmetic: ticket dispatch runs before the
 * schedule pass in the same tick, so a freed slot goes to a human's ticket first.
 */
const MAX_IN_FLIGHT_OCCURRENCES_PER_SCHEDULE = 2;

/**
 * A live run of the same schedule to blame when the ceiling refuses this
 * occurrence, or null when there is room.
 *
 * Counted over the registry rather than the ledger, because a started occurrence
 * releases its ledger slot immediately and only the claim outlives it.
 *
 * This occurrence's own claim is not excluded, and it does not need to be. On the
 * evaluation path the reservation has not been made yet, so it cannot be among
 * them. On the drain path it can be, held by a concurrent pass over the same
 * occurrence, and counting it is the right answer anyway: that pass owns the
 * occurrence and this one must stand down.
 */
async function inFlightCeilingBlocker(
  occurrence: ScheduleOccurrenceDispatch,
  deps: ScheduleDispatchDeps,
): Promise<string | null> {
  const prefix = `${scheduleSubjectKey(occurrence.scheduleId)}:`;
  const inFlight = (await deps.runRegistry.listAll()).filter((entry) =>
    entry.subjectKey.startsWith(prefix),
  );
  if (inFlight.length < MAX_IN_FLIGHT_OCCURRENCES_PER_SCHEDULE) return null;
  return inFlight[0]?.runId ?? null;
}

/** A dispatch that failed for a reason worth retrying keeps the occurrence
 *  pending with its diagnostic, because nothing external will re-deliver it. */
async function persistRetryableFailure(
  occurrence: ScheduleOccurrenceDispatch,
  deps: ScheduleDispatchDeps,
  reason: string,
): Promise<DispatchScheduleResult> {
  await deps.occurrences
    .recordError(occurrence.scheduleId, occurrence.occurrenceAt, reason)
    .catch(() => false);
  return { result: "error", reason };
}

/** The subject an occurrence competes for. See scheduleSubjectKey: passing the
 *  occurrence is the only difference 'allow' makes. */
function subjectKeyFor(occurrence: ScheduleOccurrenceDispatch): string {
  return occurrence.overlapPolicy === "allow"
    ? scheduleSubjectKey(occurrence.scheduleId, occurrence.occurrenceAt)
    : scheduleSubjectKey(occurrence.scheduleId);
}

function workflowInputFor(
  occurrence: ScheduleOccurrenceDispatch,
  subjectKey: string,
  ownerToken: string,
): AgentWorkflowInput {
  return {
    kind: "schedule",
    scheduleId: occurrence.scheduleId,
    definitionId: occurrence.definitionId,
    definitionVersion: occurrence.definitionVersion,
    nodeId: occurrence.nodeId,
    subjectKey,
    ownerToken,
    scheduledFor: occurrence.occurrenceAt.toISOString(),
    ...(occurrence.previousOccurrenceAt
      ? { previousScheduledFor: occurrence.previousOccurrenceAt.toISOString() }
      : {}),
    ...(occurrence.previousRunPullRequests.length > 0
      ? { previousRunPullRequests: occurrence.previousRunPullRequests }
      : {}),
    taskTitle: occurrence.taskTitle,
    taskDescription: occurrence.taskDescription,
  };
}

/** How many schedules one evaluation pass looks at. Bounded because evaluating
 *  one can start a 3 to 25 minute agent run, and the poll it rides on has around
 *  twenty other phases to get through. The store orders oldest-evaluated first,
 *  so the tail of a large batch is served by the next tick rather than starved. */
export const SCHEDULE_EVALUATION_LIMIT = 20;

/** How many waiting occurrences one drain pass starts at most. */
export const SCHEDULE_DRAIN_LIMIT = 10;

export interface ScheduleEvaluationMetrics {
  evaluated: number;
  /** Schedules whose node left the deployed head, so the row was revoked. */
  revoked: number;
  /** Rows whose cron no longer parses. Not revoked: the expression is authored
   *  state and only a deploy may change it. */
  invalid: number;
  due: number;
  started: number;
  /** Settled without a run: past its grace, or refused by the overlap policy. */
  skipped: number;
  /** Still pending, so a later pass will try again. */
  deferred: number;
  errors: number;
}

/**
 * Evaluate a bounded batch of schedules and dispatch whatever is due.
 *
 * Per schedule, in this order, and the order is the contract:
 *   1. resolve liveness against the deployed head, fail-closed, every tick. A
 *      row whose node is gone is revoked here and nowhere else, so this is not an
 *      optimisation of the deploy-time sync but the only thing that catches a
 *      definition disabled, archived, or rolled back past the node.
 *   2. record the evaluation pass, whether or not anything is due. It is the only
 *      column that separates "no scheduler is running here" from "nothing was due".
 *   3. ask the evaluator, then act on its single verdict.
 *
 * The watermark moves on EVALUATION, not on success. An occurrence refused by the
 * overlap policy or abandoned as stale moves it too, because the alternative is
 * re-deciding the same instant on every tick, forever, at the cost of a croner
 * bisection and a ledger write each time.
 *
 * Every schedule is isolated: one that throws is counted and the batch continues.
 * This runs inside a cron poll that must not fail because one row is broken.
 */
export async function evaluateDueSchedules(
  deps: ScheduleDispatchDeps,
  limit: number = SCHEDULE_EVALUATION_LIMIT,
): Promise<ScheduleEvaluationMetrics> {
  const metrics: ScheduleEvaluationMetrics = {
    evaluated: 0,
    revoked: 0,
    invalid: 0,
    due: 0,
    started: 0,
    skipped: 0,
    deferred: 0,
    errors: 0,
  };
  const schedules = await deps.schedules.listEvaluable(limit);
  for (const row of schedules) {
    metrics.evaluated += 1;
    try {
      await evaluateSchedule(row, deps, metrics);
    } catch (error) {
      metrics.errors += 1;
      logger.warn(
        {
          scheduleId: row.id,
          err: error instanceof Error ? error.message : String(error),
        },
        "schedule_evaluation_failed",
      );
    }
  }
  return metrics;
}

async function evaluateSchedule(
  row: ScheduleRow,
  deps: ScheduleDispatchDeps,
  metrics: ScheduleEvaluationMetrics,
): Promise<void> {
  const now = deps.now();
  // FIRST, before anything that can throw. The batch is ordered by
  // last_evaluated_at ascending with nulls first, so a schedule whose liveness
  // lookup fails would keep this column untouched, sort to the head of every
  // subsequent batch and be retried forever. Twenty such rows fill the batch and
  // no healthy schedule is ever evaluated again, while their editors all report
  // that no scheduler is running.
  await deps.schedules.recordEvaluationPass(row.id, now);

  const target = await deps.resolveScheduleTarget({
    definitionId: row.definitionId,
    nodeId: row.nodeId,
    definitionVersion: null,
  });
  if (!target) {
    await revokeAndCancelWaiting(row.id, deps, now);
    metrics.revoked += 1;
    return;
  }

  const verdict = dueOccurrence({
    cron: row.cron,
    timezone: row.timezone,
    watermark: row.evaluationWatermarkAt,
    now,
    graceMs: row.catchUpGraceMinutes * 60_000,
  });
  if (verdict.kind === "nothing-due") return;
  if (verdict.kind === "invalid") {
    metrics.invalid += 1;
    logger.warn(
      { scheduleId: row.id, cron: row.cron, problem: verdict.problem.message },
      "schedule_expression_invalid",
    );
    return;
  }

  if (verdict.kind === "stale") {
    // Admitted through accept even under the queue policy: a stale occurrence is
    // never going to run, so evicting a pending occurrence in its favour would
    // trade a live one for a dead one. "skip" rather than the row's own policy for
    // the same reason.
    const admission = await admitOccurrence(
      {
        scheduleId: row.id,
        occurrenceAt: verdict.occurrence,
        definitionId: row.definitionId,
        definitionVersion: target.definitionVersion,
        droppedOlder: verdict.droppedOlder,
        droppedOlderAtLeast: verdict.droppedOlderAtLeast,
      },
      "behind",
      deps,
    );
    if (!admission.ok) {
      // Nothing was written, so the watermark stays put and a later tick can try
      // this occurrence again. It is already past its grace, so the retry settles
      // it as stale rather than running it: no unbounded loop, just no silent loss.
      if (admission.failure.result === "not_recorded") metrics.errors += 1;
      return;
    }
    if (admission.result.admitted) {
      await deps.occurrences.recordSkipped(
        row.id,
        verdict.occurrence,
        "skipped_stale",
        { skipReason: staleReason(verdict.staleByMs, verdict.nextOccurrenceAt) },
      );
    }
    metrics.skipped += 1;
    await deps.schedules.advanceWatermark(row.id, verdict.advanceWatermarkTo);
    return;
  }

  metrics.due += 1;
  const result = await dispatchScheduleOccurrence(
    await occurrenceDispatch(
      {
        scheduleId: row.id,
        occurrenceAt: verdict.occurrence,
        definitionId: row.definitionId,
        definitionVersion: target.definitionVersion,
        droppedCount: verdict.droppedOlder,
        droppedCountCapped: verdict.droppedOlderAtLeast,
      },
      row,
      target,
      deps,
    ),
    deps,
  );
  tally(metrics, result);
  // Never advance past an occurrence the ledger has no row for. The watermark
  // moving on EVALUATION rather than on success is deliberate, but it rests on
  // the occurrence having been recorded: without a row there is nothing to skip,
  // nothing to retry and nothing to read, and the occurrence is simply gone.
  if (result.result === "not_recorded") return;
  await deps.schedules.advanceWatermark(row.id, verdict.advanceWatermarkTo);
}

export interface ScheduleDrainMetrics {
  listed: number;
  started: number;
  revoked: number;
  deferred: number;
  /** Waiting occurrences left alone because they are past their tolerance. */
  pastGrace: number;
  errors: number;
}

/**
 * A waiting occurrence that is now too late to be worth starting.
 *
 * Only under skip and allow. A pending row exists under those policies for one
 * reason, that there was no capacity, and "no capacity for a while" is not the
 * customer agreeing to a 03:00 report delivered at 20:00. The pending-age ceiling
 * alone is 24 hours, which is a backstop against unbounded growth, not a delivery
 * promise.
 *
 * queue is excluded on purpose: waiting IS what the customer asked for there, so
 * its only ceiling stays the 24 hour one.
 *
 * Nothing is settled here, following the rule that the drain never settles a row
 * it does not exclusively own. The occurrence is simply not started, and
 * expirePendingOccurrences retires it.
 */
function waitedPastGrace(
  occurrence: OccurrenceRow,
  row: ScheduleRow,
  now: Date,
): boolean {
  if (row.overlapPolicy === "queue") return false;
  return (
    now.getTime() - occurrence.occurrenceAt.getTime() >
    row.catchUpGraceMinutes * 60_000
  );
}

/** Assemble the dispatch payload for an occurrence, including the previous run's
 *  pull requests, which is the only way a run learns its predecessor left one
 *  open. Read here rather than inside the workflow so the step stays pure. */
async function occurrenceDispatch(
  occurrence: Pick<
    OccurrenceRow,
    "scheduleId" | "occurrenceAt" | "definitionId" | "droppedCount" | "droppedCountCapped"
  > & { definitionVersion: number },
  row: ScheduleRow,
  target: LiveScheduleTarget,
  deps: ScheduleDispatchDeps,
): Promise<ScheduleOccurrenceDispatch> {
  return {
    scheduleId: occurrence.scheduleId,
    occurrenceAt: occurrence.occurrenceAt,
    definitionId: occurrence.definitionId,
    definitionVersion: occurrence.definitionVersion,
    nodeId: row.nodeId,
    overlapPolicy: row.overlapPolicy as ScheduleOverlapPolicy,
    taskTitle: target.taskTitle,
    taskDescription: target.taskDescription,
    ...(target.rateLimit === undefined ? {} : { rateLimit: target.rateLimit }),
    previousOccurrenceAt: row.lastStartedOccurrenceAt,
    previousRunPullRequests: row.lastStartedRunId
      ? await deps
          .previousRunPullRequests(row.lastStartedRunId)
          .catch(() => [] as string[])
      : [],
    droppedOlder: occurrence.droppedCount,
    droppedOlderAtLeast: occurrence.droppedCountCapped,
  };
}

/**
 * Start the occurrences that were admitted but never got a run: capacity was
 * full, the subject was busy, or the start itself failed. Nothing external will
 * re-deliver a schedule occurrence, so this is the only thing that ever picks
 * them up.
 *
 * Liveness is re-resolved here too, against the version the occurrence is pinned
 * to, because a definition can be disabled while an occurrence waits and
 * listPendingOccurrences only knows about pause and revocation.
 */
export async function drainPendingScheduleOccurrences(
  deps: ScheduleDispatchDeps,
  limit: number = SCHEDULE_DRAIN_LIMIT,
): Promise<ScheduleDrainMetrics> {
  const metrics: ScheduleDrainMetrics = {
    listed: 0,
    started: 0,
    revoked: 0,
    deferred: 0,
    pastGrace: 0,
    errors: 0,
  };
  const pending = await deps.occurrences.listPending(limit);
  metrics.listed = pending.length;
  for (const occurrence of pending) {
    try {
      const row = await deps.schedules.getById(occurrence.scheduleId);
      if (!row) continue;
      const target = await deps.resolveScheduleTarget({
        definitionId: occurrence.definitionId,
        nodeId: row.nodeId,
        definitionVersion: occurrence.definitionVersion,
      });
      if (!target) {
        await revokeAndCancelWaiting(row.id, deps, deps.now());
        metrics.revoked += 1;
        continue;
      }
      if (waitedPastGrace(occurrence, row, deps.now())) {
        metrics.pastGrace += 1;
        continue;
      }
      const result = await startAdmittedOccurrence(
        await occurrenceDispatch(occurrence, row, target, deps),
        deps,
        "retry",
      );
      tally(metrics, result);
    } catch (error) {
      metrics.errors += 1;
      logger.warn(
        {
          scheduleId: occurrence.scheduleId,
          err: error instanceof Error ? error.message : String(error),
        },
        "schedule_occurrence_drain_failed",
      );
    }
  }
  return metrics;
}

/** `skipped` is optional because the drain has no such counter: it never settles
 *  an occurrence, so it cannot skip one. */
function tally(
  metrics: { started: number; skipped?: number; deferred: number; errors: number },
  result: DispatchScheduleResult,
): void {
  if (result.result === "started") metrics.started += 1;
  else if (result.result === "skipped_overlap") {
    if (metrics.skipped !== undefined) metrics.skipped += 1;
  } else if (result.result === "at_capacity" || result.result === "queued") {
    metrics.deferred += 1;
  } else if (result.result === "error" || result.result === "not_recorded") {
    // not_recorded counts as an error because it IS one for the operator: no row
    // was written, so this counter and the warning beside it are the only trace
    // the occurrence ever existed.
    metrics.errors += 1;
  }
  // "not_admitted" and "orphaned_start" are deliberately uncounted: the first is
  // another evaluator's occurrence and the second is already recorded as a
  // cancelled orphan run by the shared start lifecycle.
}

/** Why a stale occurrence was abandoned, in the two numbers an operator needs:
 *  how far past its grace it was, and when the schedule will really run next.
 *  The lateness alone is misleading on a weekly schedule, where one minute past
 *  grace still means the next real run is a week away. */
function staleReason(staleByMs: number, nextOccurrenceAt: Date | null): string {
  const minutes = Math.round(staleByMs / 60_000);
  return `stale:${minutes}m past grace, next ${nextOccurrenceAt?.toISOString() ?? "never"}`;
}

export interface ScheduleTriggerPassMetrics {
  evaluation: ScheduleEvaluationMetrics;
  drain: ScheduleDrainMetrics;
  /** Pending occurrences given up on after waiting past the age ceiling. */
  expired: number;
  /** Sub-phases that threw. The pass itself never does: it rides on a cron poll
   *  with around twenty other phases, none of which may be taken down by it. */
  failures: number;
}

/**
 * Everything a cron tick owes the schedule trigger, in order and each part
 * independently best-effort.
 *
 * Evaluation runs BEFORE the drain on purpose: a newly due occurrence must be
 * admitted first, so that under the queue policy the drain starts the newest
 * occurrence rather than the one it just replaced.
 */
export async function runScheduleTriggerPass(
  deps: ScheduleDispatchDeps,
): Promise<ScheduleTriggerPassMetrics> {
  const metrics: ScheduleTriggerPassMetrics = {
    evaluation: {
      evaluated: 0,
      revoked: 0,
      invalid: 0,
      due: 0,
      started: 0,
      skipped: 0,
      deferred: 0,
      errors: 0,
    },
    drain: {
      listed: 0,
      started: 0,
      revoked: 0,
      deferred: 0,
      pastGrace: 0,
      errors: 0,
    },
    expired: 0,
    failures: 0,
  };
  const guard = async (phase: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      metrics.failures += 1;
      logger.warn(
        { phase, err: error instanceof Error ? error.message : String(error) },
        "schedule_trigger_pass_phase_failed",
      );
    }
  };

  await guard("evaluate", async () => {
    metrics.evaluation = await evaluateDueSchedules(deps);
  });
  await guard("drain", async () => {
    metrics.drain = await drainPendingScheduleOccurrences(deps);
  });
  await guard("expire", async () => {
    metrics.expired = await deps.occurrences.expirePending(deps.now());
  });
  await guard("sweep", () => deps.occurrences.sweepSettled(deps.now()));
  return metrics;
}

/** Real ports, wired to a database and the hosted runtime. */
export function createScheduleDispatchDeps(
  db: Db,
  runRegistry: RunRegistryAdapter,
  maxConcurrentAgents: number,
): ScheduleDispatchDeps {
  return {
    runRegistry,
    maxConcurrentAgents,
    occurrences: {
      accept: (admitted) => acceptOccurrence(db, admitted),
      supersedeThenAccept: (admitted) => supersedePendingThenAccept(db, admitted),
      recordStarted: (scheduleId, occurrenceAt, ownerToken, runId) =>
        recordOccurrenceStarted(db, scheduleId, occurrenceAt, ownerToken, runId),
      recordSkipped: (scheduleId, occurrenceAt, outcome, options) =>
        recordOccurrenceSkipped(db, scheduleId, occurrenceAt, outcome, options),
      recordError: (scheduleId, occurrenceAt, message) =>
        recordOccurrenceError(db, scheduleId, occurrenceAt, message),
      recordAtCapacity: (scheduleId, occurrenceAt) =>
        recordOccurrenceAtCapacity(db, scheduleId, occurrenceAt),
      cancelWaiting: (scheduleId, reason) =>
        cancelWaitingOccurrences(db, scheduleId, reason),
      listPending: (limit) => listPendingOccurrences(db, limit),
      expirePending: (now) => expirePendingOccurrences(db, now),
      sweepSettled: (now) => sweepSettledOccurrences(db, now),
    },
    schedules: {
      listEvaluable: (limit) => listEvaluableSchedules(db, limit),
      recordEvaluationPass: (scheduleId, now) =>
        recordEvaluationPass(db, scheduleId, now),
      advanceWatermark: (scheduleId, occurrenceAt) =>
        advanceWatermark(db, scheduleId, occurrenceAt),
      revoke: (scheduleId, now) => revokeSchedule(db, scheduleId, now),
      getById: (scheduleId) => getScheduleById(db, scheduleId),
    },
    resolveScheduleTarget: memoizeScheduleTarget((query) =>
      getLiveScheduleTriggerTarget(db, query),
    ),
    consumeTriggerRateLimit: (key, config, now) =>
      enforceTriggerRateLimit(db, key, config, now),
    previousRunPullRequests: (runId) => readRunPullRequestUrls(db, runId),
    startWorkflow: async (input) => (await start(agentWorkflow, [input])).runId,
    orphanStartedRun: async (started) => {
      const { recordAndCancelOrphanStartedRun } = await import(
        "../lib/run-start-lifecycle.js"
      );
      await recordAndCancelOrphanStartedRun(started);
    },
    now: () => new Date(),
  };
}

/**
 * Resolve each distinct schedule target at most once per deps object, which is
 * once per poll invocation.
 *
 * Liveness is still fail-closed and still resolved every tick: the cache lives
 * exactly as long as one pass, so nothing carries between ticks. What it removes
 * is the repeat within a pass, where the evaluation and the drain ask about the
 * same schedule and every lookup is a separate HTTP round trip on neon-http.
 */
function memoizeScheduleTarget(
  resolve: ScheduleDispatchDeps["resolveScheduleTarget"],
): ScheduleDispatchDeps["resolveScheduleTarget"] {
  const cache = new Map<string, Promise<LiveScheduleTarget | null>>();
  return (query) => {
    const key = `${query.definitionId}:${query.nodeId}:${query.definitionVersion ?? "head"}`;
    const hit = cache.get(key);
    if (hit) return hit;
    // The promise is cached, not the value, so concurrent callers share one
    // round trip rather than racing to fill the same entry.
    const pending = resolve(query);
    cache.set(key, pending);
    return pending;
  };
}

/** Pull request URLs a run recorded, empty for a run that opened none. */
async function readRunPullRequestUrls(db: Db, runId: string): Promise<string[]> {
  const { workflowRuns } = await import("../db/schema.js");
  const { eq } = await import("drizzle-orm");
  const rows = await db
    .select({ prs: workflowRuns.prs })
    .from(workflowRuns)
    .where(eq(workflowRuns.runId, runId))
    .limit(1);
  return (rows[0]?.prs ?? []).map((pr) => pr.url);
}
