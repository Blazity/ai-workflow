// Static import so route tests can vi.mock("workflow/api"): a dynamic import
// would bypass the module mock and hit the real Workflow runtime.
import {
  MAX_CLARIFICATION_ANSWER_LENGTH,
  repositoryCatalogKey,
  type RepositoryKey,
  type SettingsSnapshot,
} from "@shared/contracts";
import { getHookByToken, resumeHook } from "workflow/api";
import { env } from "../../infra/vcs-config.js";
import { HookNotFoundError } from "workflow/errors";
import type { Db } from "../../db/types.js";
import { loadRepositoryCatalogEntries } from "../repository-catalog/index.js";
import {
  getRepositoryCatalogStateRow,
  listRepositoryCatalogRows,
} from "../../db/repositories/repository-catalog.js";
import {
  recordRepositoryAnswer,
  type RepositoryAnswerPersistence,
} from "../work-scope/index.js";
import {
  commentsCoverAnswerWindow,
  isComposedAnswerActor,
  readAnswerAuthorship,
  UNCOUNTED_AUTHORS_ERROR,
} from "./answer-authorship.js";
import {
  applyAnswerWorkScopePlan,
  applyConnectedAnswerWorkScopePlan,
  readConnectedWorkScope,
  readWorkScope,
} from "../../db/repositories/work-scope.js";
import {
  IssueTrackerNotFoundError,
  type IssueTrackerAdapter,
  type TicketComment,
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
import {
  formatAnswerNotRecordedComment,
  type AnswerNotRecordedReason,
  formatClarificationAnswerComment,
  aLaterRunCanPickUpAskedRepositories,
} from "./comment-format.js";
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
interface AnswerPersistence extends RepositoryAnswerPersistence {
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

/** The catalog as the answer reader and the decision want it, from whichever
 *  tier owns it on this path. */
function catalogKeysOf(
  activated: boolean,
  rows: Array<{ provider: string; path: string; enabled: boolean }>,
) {
  const keys: RepositoryKey[] = [];
  const enabledKeys: RepositoryKey[] = [];
  for (const row of rows) {
    const key = repositoryCatalogKey({ provider: row.provider, path: row.path });
    keys.push(key);
    if (row.enabled) enabledKeys.push(key);
  }
  return { activated, keys, enabledKeys };
}

async function readRepositoryCatalogKeys(db: Db) {
  const [state, rows] = await Promise.all([
    getRepositoryCatalogStateRow(db),
    listRepositoryCatalogRows(db),
  ]);
  return catalogKeysOf(state.activated, rows);
}

async function loadConnectedRepositoryCatalogKeys() {
  const { state, entries } = await loadRepositoryCatalogEntries();
  return catalogKeysOf(state.activated, entries);
}

async function moveTicketToAiColumn(input: {
  persistence: AnswerPersistence;
  issueTracker: Pick<IssueTrackerAdapter, "fetchTicket" | "moveTicket">;
  ticketKey: string;
  row: HookClarificationRow;
  aiColumn: string;
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
    target: aiColumnMoveTarget({
      COLUMN_AI: input.aiColumn,
      JIRA_AI_TRANSITION_ID: env.JIRA_AI_TRANSITION_ID,
    }),
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
 * `answerAuthorCount` is how many people the caller composed these words from,
 * which only the Jira comment path can say and only the record below reads.
 */
type AnswerClarificationInput = {
  row: HookClarificationRow;
  rawAnswer: string;
  actor: { id: string; label: string };
  issueTracker: Pick<
    IssueTrackerAdapter,
    "fetchTicket" | "moveTicket" | "postComment" | "getCurrentUserAccountId"
  >;
  skipTicketFetch?: boolean;
  skipTicketMove?: boolean;
  skipAnswerComment?: boolean;
  /** The number of distinct people whose words this answer is made of, as the
   *  fact and never as something to read back out of the text. Set by the one
   *  channel that composes an answer out of several comments, at the moment it
   *  composes it. Left out by the channels that compose nothing (the dashboard
   *  and MCP each deliver one person's answer as they typed it) and by any
   *  delivery of a stored answer, which the record counts again from the ticket
   *  rather than believing the delivery. */
  answerAuthorCount?: number;
  aiColumn?: string;
  cancelSettings: Pick<SettingsSnapshot, "COLUMN_AI" | "COLUMN_BACKLOG">;
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
    finishFailed: (failed) =>
      finishFailedResume({ db, settings: input.cancelSettings, ...failed }),
    retireGoneTicket: (row) => retireClarificationForGoneTicket(db, row),
    markResumed: (runId) => markRunResumed(db, runId),
    repositoryCatalog: () => readRepositoryCatalogKeys(db),
    readWorkScope: (subjectKey) => readWorkScope(db, subjectKey),
    applyAnswerWorkScope: (plan) => applyAnswerWorkScopePlan(db, plan),
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
    finishFailed: (failed) =>
      finishConnectedFailedResume({ settings: input.cancelSettings, ...failed }),
    retireGoneTicket: retireConnectedClarificationForGoneTicket,
    markResumed: markConnectedRunResumed,
    repositoryCatalog: loadConnectedRepositoryCatalogKeys,
    readWorkScope: readConnectedWorkScope,
    applyAnswerWorkScope: applyConnectedAnswerWorkScopePlan,
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
  // checkpoints still fail early when their ticket has been deleted. The
  // comments come back with that read, and the record below counts the authors
  // of a stored answer from them rather than paying a second read for the same
  // bytes; every delivery that can need the count makes this fetch.
  let ticketComments: readonly TicketComment[] | null = null;
  // Whether that read holds every comment that could be part of this answer. A
  // read with a gap in that window can only ever say what IS on the ticket,
  // never what is not, and the count below turns on exactly that difference.
  let ticketCommentsCoverWindow = false;
  if (row.ticketKey && !input.skipTicketFetch) {
    try {
      // With the window: this read exists to count the people who wrote the
      // answer, which is a question about the comments since the question was
      // asked and about nothing else.
      const ticket = await issueTracker.fetchTicket(row.ticketKey, {
        commentsSince: row.askedAt.toISOString(),
      });
      ticketComments = ticket.comments;
      ticketCommentsCoverWindow = commentsCoverAnswerWindow(ticket, row.askedAt.getTime());
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
        aiColumn: input.aiColumn ?? "AI",
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

  const answeredAt = answered.answeredAt;
  if (!answeredAt) return { kind: "conflict" };

  // Counted BEFORE the resume attempt is reserved, because the only thing that
  // can stop here is our own bookkeeping. The three attempts are the person's
  // budget for getting their answer delivered; spending one of them on a moment
  // when WE could not count the authors cancels a run over a perfectly good
  // answer after three unlucky identity reads. A hold takes nothing from that
  // budget, and its own bound is inside the count.
  //
  // Counting only. Nothing is written and nothing is posted until the
  // reservation below proves this delivery is the one going ahead, exactly as
  // before: a delivery that loses that race must leave the ticket and the
  // record as it found them.
  const authorship = await readAnswerAuthorship({
    row,
    answeredAt,
    answerer,
    authorCount: input.answerAuthorCount,
    issueTracker,
    ticketComments,
    ticketCommentsCoverWindow,
  });
  if (authorship.kind === "hold") {
    // Nothing is wrong with the answer: what could not be done, right now, is
    // telling how many people wrote it. Fail the delivery the way a failed
    // resume fails, BEFORE the hook is spent. Resuming here would consume the
    // hook, take the row out of the resumable set with it, and leave a good
    // single person's answer unrecorded for good, with no delivery left that
    // could ever record it. Retryable costs a repeated delivery; the
    // alternative costs the answer.
    //
    // Only while a later delivery could do better. When the comments the answer
    // was composed from are gone for good, and when the counting has had its own
    // window and spent it, nothing is written and the delivery goes through: see
    // `readAnswerAuthorship`.
    return { kind: "resume_failed_retryable", error: new Error(UNCOUNTED_AUTHORS_ERROR) };
  }

  const reservation = await persistence.reserve(answered.id, answeredAt);
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

  // Before the resume, because the resumed run reads the RECORD and never the
  // answer text: a run that died between the two would otherwise lose what a
  // person said, and the next run would ask them again.
  let recordTold: AnswerNotRecordedReason | undefined;
  if (authorship.kind === "write") {
    recordTold = await recordRepositoryAnswer(persistence, {
      row,
      answer,
      answeredAt,
      answerer,
      composedFromComments: isComposedAnswerActor(answerer.id),
      ...(authorship.authorCount === undefined ? {} : { authorCount: authorship.authorCount }),
    });
  }
  // Why this answer left no repository decision behind it, said out loud where
  // the person who answered can see it, because the next run may ask them the
  // same thing. Best effort, and never able to fail a delivery that is going
  // ahead: the answer is the run's, whatever the ticket ends up saying.
  //
  // One sentence, never two. Counting the authors decides whether the words are
  // read at all, so when that count has something to say it is the more
  // specific of the two and goes first: an answer several people wrote is told
  // that, not that it named no repository.
  const tell = authorship.tell ?? recordTold;
  if (tell !== undefined && row.ticketKey) {
    const ticketKey = row.ticketKey;
    await issueTracker
      .postComment(
        ticketKey,
        formatAnswerNotRecordedComment(tell, {
          listedRepositories: (row.askedRepositories?.length ?? 0) > 0,
          // The second fact the sentence needs, and this row is the only place
          // that holds it: a question the run raised about a repository the
          // catalog does not enable or cannot serve offers a path route that
          // the next run cannot honour.
          aLaterRunCanPickThemUp: aLaterRunCanPickUpAskedRepositories(row.askedRepositories),
        }),
      )
      .catch((error: unknown) => {
        logger.warn(
          { ticketKey, runId: row.runId, error: (error as Error).message },
          "work_scope_answer_not_counted_comment_failed",
        );
        return null;
      });
  }

  try {
    await resumeHook(answered.hookToken, {
      answer,
      answeredById: answerer.id,
      answeredByLabel: answerer.label,
      answeredAt: answeredAt.toISOString(),
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
