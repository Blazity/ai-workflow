// Static import so route tests can vi.mock("workflow/api"): a dynamic import
// would bypass the module mock and hit the real Workflow runtime.
import { MAX_CLARIFICATION_ANSWER_LENGTH } from "@shared/contracts";
import { getHookByToken, resumeHook } from "workflow/api";
import { env } from "../../infra/vcs-config.js";
import { HookNotFoundError } from "workflow/errors";
import type { Db } from "../../db/types.js";
import {
  IssueTrackerNotFoundError,
  type IssueTrackerAdapter,
} from "../../adapters/issue-tracker/types.js";
import { logger } from "../../infra/logger.js";
import { aiColumnMoveTarget } from "../tickets/index.js";
import {
  markConnectedRunBlockedOnCancel,
  markConnectedRunResumed,
  markRunBlockedOnCancel,
  markRunResumed,
} from "../../db/repositories/runs/telemetry.js";
import {
  moveConnectedTicketForRun,
  moveTicketForRun,
} from "../tickets/index.js";
import { formatClarificationAnswerComment } from "./comment-format.js";
import {
  answerConnectedHookClarification,
  answerHookClarification,
  type HookClarificationRow,
} from "../../db/repositories/clarification-hooks.js";
import {
  finishConnectedFailedResume,
  finishFailedResume,
  reserveConnectedResumeAttempt,
  reserveResumeAttempt,
  RESUME_FAILED_STATUS,
  type ResumeAttemptReservation,
} from "./resume-attempts.js";
import {
  supersedeConnectedClarification,
  supersedeConnectedPendingClarificationsForTicket,
  supersedeClarification,
  supersedePendingForTicket,
} from "../../db/repositories/clarifications.js";
import {
  findBoundActiveRunOwner,
  findConnectedBoundActiveRunOwner,
} from "../../db/repositories/active-runs.js";

/** Re-exported under the name this cluster has always used. The number itself
 *  belongs to the contracts package, which is also what the request schema and
 *  the MCP tool catalogue read, so no channel can judge an answer by a different
 *  limit than the one a client was told. */
export const MAX_ANSWER_LENGTH = MAX_CLARIFICATION_ANSWER_LENGTH;

export type AnswerClarificationOutcome =
  | { kind: "answered"; row: HookClarificationRow }
  | { kind: "invalid_answer" }
  | { kind: "conflict" }
  | { kind: "resume_terminal" }
  | { kind: "ticket_gone" }
  | { kind: "ticket_transition_failed"; error: unknown }
  | { kind: "resume_failed_retryable"; error: unknown }
  | { kind: "resume_exhausted"; error: unknown };

/**
 * Bring a parked ticket back to the configured AI column so its status matches
 * the run that is about to wake up. Rides the asking run's own subject claim:
 * the run still holds it while suspended on the hook, so the same owner fence
 * that guards every other run-driven move guards this one. A missing bound
 * claim means no run can work this ticket, so it must not be moved either;
 * that is logged, not raised, because the answer itself is still legitimate.
 */
interface AnswerPersistence {
  findBoundOwner(input: { subjectKey: string; runId: string }): Promise<{ ownerToken: string } | null>;
  transitionTicket(input: {
    issueTracker: Pick<IssueTrackerAdapter, "fetchTicket" | "moveTicket">;
    ticketKey: string;
    target: ReturnType<typeof aiColumnMoveTarget>;
    owner: { subjectKey: string; ownerToken: string; runId: string };
  }): Promise<void>;
  answer(
    id: string,
    answer: string,
    actor: { id: string; label: string },
  ): Promise<HookClarificationRow | null>;
  reserve(id: string, answeredAt: Date): Promise<ResumeAttemptReservation | null>;
  finishFailed(input: {
    row: HookClarificationRow;
    reservation: ResumeAttemptReservation;
    issueTracker: Pick<IssueTrackerAdapter, "fetchTicket" | "moveTicket" | "postComment">;
    error: unknown;
  }): Promise<"retryable" | "exhausted" | "lost">;
  retireGoneTicket(row: HookClarificationRow): Promise<void>;
  markResumed(runId: string): Promise<void>;
}

async function moveTicketToAiColumn(input: {
  persistence: AnswerPersistence;
  issueTracker: Pick<IssueTrackerAdapter, "fetchTicket" | "moveTicket">;
  ticketKey: string;
  row: HookClarificationRow;
}): Promise<void> {
  const owner = await input.persistence.findBoundOwner({
    subjectKey: input.row.subjectKey,
    runId: input.row.runId,
  });
  if (!owner) {
    logger.warn(
      { ticketKey: input.ticketKey, runId: input.row.runId },
      "clarification_answer_transition_skipped_no_bound_owner",
    );
    return;
  }
  await input.persistence.transitionTicket({
    issueTracker: input.issueTracker,
    ticketKey: input.ticketKey,
    target: aiColumnMoveTarget(env),
    owner: {
      subjectKey: input.row.subjectKey,
      ownerToken: owner.ownerToken,
      runId: input.row.runId,
    },
  });
}

/**
 * Answer a pending clarification and resume its asking run, with the CAS and
 * retry semantics shared by every caller (dashboard and, later, Jira webhook).
 * Returns a tagged outcome instead of throwing HTTP errors so the transport
 * layer owns status-code mapping; the ticket fetch is injected so this module
 * stays free of adapter-construction and HTTP concerns.
 *
 * `skipTicketMove` is for callers that already proved the ticket is live in the
 * AI column (the Jira comment path only ever commits from there), so they do
 * not pay a second provider read for a move that could only be a no-op.
 * `skipAnswerComment` is for callers whose answer already exists as a ticket
 * comment, so mirroring it back would duplicate what a human just wrote.
 */
type AnswerClarificationInput = {
  row: HookClarificationRow;
  rawAnswer: string;
  actor: { id: string; label: string };
  issueTracker: Pick<IssueTrackerAdapter, "fetchTicket" | "moveTicket" | "postComment">;
  skipTicketFetch?: boolean;
  skipTicketMove?: boolean;
  skipAnswerComment?: boolean;
};

/** Explicit-db path kept for pglite tests and service callers that have an
 * already-scoped database client. Production request paths use the connected
 * variant below. */
export function answerClarificationAndResume(
  input: AnswerClarificationInput & { db: Db },
): Promise<AnswerClarificationOutcome> {
  const { db } = input;
  return answerClarificationAndResumeWithPersistence(input, {
    findBoundOwner: (owner) => findBoundActiveRunOwner(db, owner),
    transitionTicket: (move) => moveTicketForRun({ db, ...move }),
    answer: (id, answer, actor) => answerHookClarification(db, id, answer, actor),
    reserve: (id, answeredAt) => reserveResumeAttempt(db, id, answeredAt),
    finishFailed: (failed) => finishFailedResume({ db, ...failed }),
    retireGoneTicket: (row) => retireClarificationForGoneTicket(db, row),
    markResumed: (runId) => markRunResumed(db, runId),
  });
}

/** Production path: services provide policy inputs, repositories own every
 * database operation and resolve their connected client internally. */
export function answerConnectedClarificationAndResume(
  input: AnswerClarificationInput,
): Promise<AnswerClarificationOutcome> {
  return answerClarificationAndResumeWithPersistence(input, {
    findBoundOwner: findConnectedBoundActiveRunOwner,
    transitionTicket: moveConnectedTicketForRun,
    answer: answerConnectedHookClarification,
    reserve: reserveConnectedResumeAttempt,
    finishFailed: finishConnectedFailedResume,
    retireGoneTicket: retireConnectedClarificationForGoneTicket,
    markResumed: markConnectedRunResumed,
  });
}

async function answerClarificationAndResumeWithPersistence(
  input: AnswerClarificationInput,
  persistence: AnswerPersistence,
): Promise<AnswerClarificationOutcome> {
  const { row, rawAnswer, actor, issueTracker } = input;

  const answer = rawAnswer.trim();
  if (!answer || answer.length > MAX_ANSWER_LENGTH) {
    return { kind: "invalid_answer" };
  }

  const isResumeRetry = row.status === "answered" && row.answer === answer;
  if (row.status === RESUME_FAILED_STATUS) return { kind: "resume_terminal" };
  if (row.status !== "pending" && !isResumeRetry) {
    return { kind: "conflict" };
  }

  const answerer = isResumeRetry
    ? { id: row.answeredById ?? actor.id, label: row.answeredByLabel ?? actor.label }
    : actor;

  // Ticketless scope:any continuations have no Jira lifecycle. Ticket-backed
  // checkpoints still fail early when their ticket has been deleted.
  if (row.ticketKey && !input.skipTicketFetch) {
    try {
      await issueTracker.fetchTicket(row.ticketKey);
    } catch (err) {
      if (!(err instanceof IssueTrackerNotFoundError)) throw err;
      await persistence.retireGoneTicket(row);
      return { kind: "ticket_gone" };
    }
  }

  // The ticket parked itself in the backlog when the question was asked, so put
  // it back in the AI column BEFORE the run wakes up: a resumed run must never
  // work a ticket Jira still shows as AI Backlog. Ordered ahead of the answer
  // CAS so a failed transition leaves the question answerable again instead of
  // stranding a live run behind a stale column, and surfaced as its own outcome
  // so the caller can retry it rather than swallow it.
  if (row.ticketKey && !input.skipTicketMove) {
    try {
      await moveTicketToAiColumn({
        persistence,
        issueTracker,
        ticketKey: row.ticketKey,
        row,
      });
    } catch (error) {
      return { kind: "ticket_transition_failed", error };
    }
  }

  const answered = isResumeRetry
    ? row
    : await persistence.answer(row.id, answer, answerer);
  if (!answered) {
    return { kind: "conflict" };
  }

  if (!answered.answeredAt) return { kind: "conflict" };
  const reservation = await persistence.reserve(answered.id, answered.answeredAt);
  if (!reservation) return { kind: "conflict" };

  // Mirror the answer into the ticket. The question was posted there publicly,
  // so the answer that unblocked the run belongs there too; without this the
  // ticket shows a question, a status change, and nothing in between. Posted
  // only on the branch that actually recorded the answer, which makes it
  // exactly-once without any new state: an identical retry re-drives the resume,
  // not the trace. Best-effort in the strongest sense, because a comment must
  // never fail an answer that is already committed. Safe against the comment
  // path reading it back: that path skips comments authored by the bot account.
  if (row.ticketKey && !input.skipAnswerComment && !isResumeRetry) {
    const ticketKey = row.ticketKey;
    await issueTracker
      .postComment(
        ticketKey,
        formatClarificationAnswerComment({ answeredByLabel: answerer.label, answer }),
      )
      .catch((error: unknown) => {
        logger.warn(
          { ticketKey, runId: row.runId, error: (error as Error).message },
          "clarification_answer_comment_failed",
        );
        return null;
      });
  }

  try {
    await resumeHook(answered.hookToken, {
      answer,
      answeredById: answerer.id,
      answeredByLabel: answerer.label,
      answeredAt: answered.answeredAt?.toISOString() ?? new Date().toISOString(),
    });
  } catch (error) {
    // If the hook still exists, the resume definitely did not commit and the
    // same answer can be retried. A missing hook means the resume won, but only
    // an explicit not-found result can establish that the HTTP response was lost
    // (or another identical retry already won).
    let hookAfterResume;
    try {
      hookAfterResume = await getHookByToken(answered.hookToken);
    } catch (verificationError) {
      if (HookNotFoundError.is(verificationError)) {
        hookAfterResume = null;
      } else {
        return failedResumeOutcome(persistence, answered, reservation, issueTracker, verificationError);
      }
    }
    if (hookAfterResume !== null) {
      return failedResumeOutcome(persistence, answered, reservation, issueTracker, error);
    }
  }

  // The answer is delivered, so the asking run is live again. Clearing the park
  // marker here (and not only from the resumed workflow body) means the run
  // stops reading as awaiting input the moment the answer lands, however long
  // the resumed body takes to reach its next write. Guarded on "awaiting" and
  // best-effort: a status write must never fail a delivered answer.
  await persistence.markResumed(row.runId).catch(() => {});

  return { kind: "answered", row: answered };
}

/** Finish a failed reserved delivery and report whether anything is left. */
async function failedResumeOutcome(
  persistence: AnswerPersistence,
  row: HookClarificationRow,
  reservation: ResumeAttemptReservation,
  issueTracker: Pick<IssueTrackerAdapter, "fetchTicket" | "moveTicket" | "postComment">,
  error: unknown,
): Promise<AnswerClarificationOutcome> {
  const attempt = await persistence.finishFailed({ row, reservation, issueTracker, error });
  return attempt === "exhausted"
    ? { kind: "resume_exhausted", error }
    : attempt === "lost"
      ? { kind: "conflict" }
      : { kind: "resume_failed_retryable", error };
}

/**
 * Best-effort teardown when a clarification's Jira ticket has been deleted:
 * supersede sibling questions, supersede this row, and settle the parked run so
 * it does not stay awaiting forever. Each step swallows its own error.
 *
 * The run is settled as "blocked", not "success": it is still suspended on a
 * hook whose question was just superseded, so nobody can answer it and it will
 * never reach a PR. Recording success would freeze that dead run into a green
 * result the cron can no longer correct.
 */
export async function retireClarificationForGoneTicket(
  db: Db,
  row: HookClarificationRow,
): Promise<void> {
  if (row.ticketKey) {
    await supersedePendingForTicket(db, row.ticketKey).catch(() => {});
  }
  await supersedeClarification(db, row.id).catch(() => {});
  await markRunBlockedOnCancel(db, row.runId).catch(() => {});
}

export async function retireConnectedClarificationForGoneTicket(
  row: HookClarificationRow,
): Promise<void> {
  if (row.ticketKey) {
    await supersedeConnectedPendingClarificationsForTicket(row.ticketKey).catch(() => {});
  }
  await supersedeConnectedClarification(row.id).catch(() => {});
  await markConnectedRunBlockedOnCancel(row.runId).catch(() => {});
}
