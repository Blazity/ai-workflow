// Static import so route tests can vi.mock("workflow/api"): a dynamic import
// would bypass the module mock and hit the real Workflow runtime.
import {
  MAX_CLARIFICATION_ANSWER_LENGTH,
  repositoryCatalogKey,
  type RepositoryKey,
  type SettingsSnapshot,
  type WorkScope,
  type WorkScopeQuestionAnswer,
  type WorkScopeWritePlan,
} from "@shared/contracts";
import { getHookByToken, resumeHook } from "workflow/api";
import { env } from "../../infra/vcs-config.js";
import { HookNotFoundError } from "workflow/errors";
import type { Db } from "../../db/types.js";
import { readRepositoryAnswer } from "../../engine/work-scope/answer.js";
import {
  hasNoWords,
  parseRepositoryExpansionAnswer,
  refusalNamesRepositories,
  withoutQuotedQuestions,
} from "../../engine/repository-discovery/runner.js";
import { decideWorkScope } from "../../engine/work-scope/decide.js";
import { loadRepositoryCatalogEntries } from "../repository-catalog/index.js";
import {
  getRepositoryCatalogStateRow,
  listRepositoryCatalogRows,
} from "../../db/repositories/repository-catalog.js";
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
  type TicketContent,
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
  /** Every catalog key and the enabled half of it. An answer is read against
   *  every key, enabled or not, because a person naming back the repository
   *  they were asked about must be understood even while the catalog refuses
   *  it. */
  repositoryCatalog(): Promise<{
    activated: boolean;
    keys: RepositoryKey[];
    enabledKeys: RepositoryKey[];
  }>;
  readWorkScope(subjectKey: string): Promise<WorkScope | null>;
  applyAnswerWorkScope(input: {
    subjectKey: string;
    runId: string;
    clarificationId: string;
    plan: WorkScopeWritePlan;
  }): Promise<{ outcome: "applied"; version: number } | { outcome: "already_applied" }>;
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

/** How the Jira comment path composes an answer: each qualifying comment as
 *  "<author>: <body>", joined with a blank line
 *  (`services/clarifications/resume-from-comments.ts:257-258`). The space after
 *  the colon is what keeps "github:acme/web" from reading as an author. The
 *  expansion protocol's refusal reader knows the same two shapes
 *  (`engine/repository-discovery/runner.ts:1447-1448`), where it asks a
 *  different question of them: whether every part is a refusal, trying each
 *  part with the prefix and without it, so it never drops a byte either way. */
const COMPOSED_COMMENT_SEPARATOR = "\n\n";
const COMPOSED_AUTHOR_PREFIX = /^[^:\n]+: /;

/**
 * The answer with the composed author taken off the front of each comment, and
 * every other byte kept: what the person wrote is the answer. Without this a
 * bare reply of "api, web" arrives as "Filip Maszota: api, web" and names
 * nobody the reader knows.
 *
 * Per comment, never per paragraph. A blank line is a paragraph break inside
 * one Jira comment at least as often as it is the join between two of them, so
 * stripping a prefix from every piece eats the start of a paragraph: "Ada:
 * Sure.\n\nacme/api: that is the backend" loses the half that names the
 * repository, and the person is asked again about a repository they just named.
 *
 * What tells a comment from a paragraph is the author, and here the author is
 * known: only an answer no more than one person wrote is ever read (the guard
 * below declines the rest), so every comment in it opens with the SAME name.
 * Taking that name from the front of the answer gives the exact prefix each of
 * this person's comments carries, and a paragraph of their own cannot match it
 * unless they wrote their own name in front of it.
 */
function withoutComposedAuthors(answer: string): string {
  const [author] = COMPOSED_AUTHOR_PREFIX.exec(answer) ?? [];
  if (author === undefined) return answer;
  return answer
    .split(COMPOSED_COMMENT_SEPARATOR)
    .map((comment) => (comment.startsWith(author) ? comment.slice(author.length) : comment))
    .join(COMPOSED_COMMENT_SEPARATOR);
}

/**
 * Every comment that could be part of an answer: written by somebody who is not
 * us, in the window the answer was given in, with something in it. One filter,
 * used by the delivery that composes an answer out of comments and by the
 * record that counts its authors again later, so the two can never read the
 * same ticket differently.
 *
 * `throughMs` is the outer bound a recount carries, and it is the moment the
 * answer was stored. The words were complete then; anything said afterwards is
 * a conversation about them, and counting a "thanks" that arrived while a
 * resume was being retried would decline a perfectly good single person's
 * answer. It is only the outer bound: `composedAnswerEvidence` below closes the
 * window where the answer itself ends, which is what the composing delivery read
 * and therefore what both sides have to count.
 *
 * THE WINDOW IS (asked, answered]: open at the question, closed at the answer.
 * The two edges are spelled differently on purpose and round the same way,
 * away from crediting a decision to words nobody wrote as an answer to this
 * question. A comment stamped at the very instant the question was recorded
 * cannot be answering it, because the question reaches the ticket after that
 * instant, so it stays out. A comment stamped at the very instant the answer
 * was stored is part of what the composing delivery read, so it stays in:
 * dropping it would take an author off the count, and a count short by one is
 * how two people's words become one person's decision.
 */
export function qualifyingComments(
  comments: readonly TicketComment[],
  botAccountId: string,
  window: { afterMs: number; throughMs?: number },
): TicketComment[] {
  return comments.filter((c) => {
    // Comments without an accountId cannot be proven non-bot.
    if (!c.accountId || c.accountId === botAccountId) return false;
    // An app is not a person. Jira says so on every comment it knows the author
    // of, and only "app" is an account that decides nothing: an automation
    // rule, an integration, a webhook writing under its own identity. Dropped
    // here rather than in the count alone, so it leaves the composed answer and
    // the count together and nobody is answered on a robot's behalf.
    //
    // Only "app". A service desk customer and an ordinary Atlassian account are
    // both people, and an account type we have never seen is a person too: the
    // failure directions are not equal, and reading an unknown as an app would
    // silently start dropping real people's answers.
    //
    // THE LIMIT, SAID OUT LOUD: this catches automation that posts AS AN APP,
    // which is the common shape and the one that declines every answer on every
    // ticket. A Jira rule configured to comment as a named user is reported as
    // that user, so from this payload it IS a person, and it still costs that
    // answer its attribution. That case is open, not closed.
    if (c.accountType === "app") return false;
    // (asked, answered], as the doc above sets out.
    const createdAtMs = Date.parse(c.createdAt);
    if (createdAtMs <= window.afterMs) return false;
    if (window.throughMs !== undefined && createdAtMs > window.throughMs) return false;
    // An empty/whitespace body (e.g. an image-only comment flattened by
    // extractAdfText) is not an answer; treat it like no comment so the nudge
    // rules apply instead of resuming with a junk answer.
    return c.body.trim().length > 0;
  });
}

/**
 * Does this read hold every comment that could belong to an answer given after
 * `afterMs`?
 *
 * A different question from "is the whole ticket here", and a much easier one
 * to answer yes to. Completeness of the whole list is the adapter's honest
 * statement about what it read; this is the only part of it anybody here needs.
 * A ticket longer than one read may page through is read from its newest end,
 * so what is missing from it was written before what is present: if the read
 * vouches for everything since before the question was asked, then no answer to
 * that question is missing, however long the ticket is. Without this a ticket
 * with thousands of comments could never be answered through comments again,
 * which is an outage we would have inflicted on ourselves.
 *
 * False is still the answer when the read cannot say. A gap that could hide
 * somebody's words is the case every reader below must refuse: it must not
 * nudge a person who has answered, must not compose half a conversation into a
 * decision, and must not call an answer's evidence deleted.
 */
export function commentsCoverAnswerWindow(
  ticket: Pick<TicketContent, "commentsComplete" | "commentsCompleteFrom">,
  afterMs: number,
): boolean {
  if (ticket.commentsComplete === true) return true;
  if (ticket.commentsCompleteFrom === undefined) return false;
  const fromMs = Date.parse(ticket.commentsCompleteFrom);
  return Number.isFinite(fromMs) && fromMs <= afterMs;
}

/**
 * How many people an answer composed from comments came from, counted by
 * account id.
 *
 * The account id is the person; the display name is a label sitting on top of
 * one. Every comment reaching this count has an id, because `qualifyingComments`
 * drops the ones that do not, and that id answers the only question here
 * exactly: two people always hold two ids however they are named, and one
 * person renamed between two comments still holds one. Counting names instead
 * gets both of those wrong, and the second one wrong in the direction that
 * costs a person their answer: a display name is missing or generic on a
 * deactivated, anonymised or app-proxied author, so one person's two comments
 * can arrive under two names and stop being recorded for good.
 */
export function composedAuthorCount(comments: readonly TicketComment[]): number {
  return new Set(comments.map((c) => c.accountId)).size;
}

/**
 * The comments a composed answer is made of. ONE window, stated once, for the
 * delivery that composes the answer and for the recount that judges it later.
 *
 * The window opens at the question and closes at the last comment the answer's
 * own author wrote, not at a clock reading. Two clocks would give two answers:
 * the composing delivery reads the ticket, and the answer is stored a moment
 * later, so a recount bounded at the stored-at instant counts comments that
 * arrived in between, which are words the answer does not contain and nobody
 * delivered to the run. The same answer would then be one person's through the
 * channel that composed it and two people's through a channel that handed it
 * back, which is the one thing a recount exists to prevent.
 *
 * The last comment of the answer is knowable without reading a byte of it: the
 * composing delivery attributes the answer to whoever wrote last, and that
 * account id is on the row. Comments after it are a conversation the answer
 * never carried.
 *
 * WHERE THE TWO ARE NOT IDENTICAL, and they are not always: the composing
 * delivery also stops at the answer length cap, and which comments it had to
 * leave off is not written down anywhere. On a truncated answer this window is
 * therefore the wider of the two, and can hold a comment whose words are not in
 * the stored text. The consequence is a count that is too high rather than too
 * low, so such an answer is declined and the question asked again, which is the
 * direction this whole path rounds in: a repeated question is a cost, a
 * fabricated decision is a defect. Narrowing it would mean recording which
 * comments the text was built from, which is a column and a migration, and
 * nothing seen so far pays for that.
 */
function composedAnswerEvidence(input: {
  comments: readonly TicketComment[];
  botAccountId: string;
  afterMs: number;
  throughMs: number;
  authorAccountId: string;
}): TicketComment[] {
  const inWindow = qualifyingComments(input.comments, input.botAccountId, {
    afterMs: input.afterMs,
    throughMs: input.throughMs,
  });
  // Their LAST one: a person who answered, was asked to be more specific and
  // answered again wrote the whole of it, and the answer runs to the end of
  // what they said.
  let last: TicketComment | undefined;
  for (const c of inWindow) {
    if (c.accountId === input.authorAccountId) last = c;
  }
  // Nothing of theirs left in the window: whatever is here, the answer was not
  // composed from it, and the caller reads an empty set as evidence gone.
  if (!last) return [];
  const boundaryMs = Date.parse(last.createdAt);
  return inWindow.filter((c) => Date.parse(c.createdAt) <= boundaryMs);
}

/** Our own account id, or null when the provider will not say. Without it we
 *  cannot tell our own questions and nudges from a human answer, so every
 *  caller fails closed on null. */
export async function readBotAccountId(
  issueTracker: Pick<IssueTrackerAdapter, "getCurrentUserAccountId">,
  ticketKey: string,
): Promise<string | null> {
  try {
    const id = (await issueTracker.getCurrentUserAccountId?.())?.trim() ?? "";
    if (id) return id;
  } catch {
    // Fall through: identity unavailable.
  }
  logger.warn({ ticketKey }, "clarification_resume_bot_identity_unavailable");
  return null;
}

/**
 * How many people a STORED answer was composed from, counted again from the
 * comments it was composed from.
 *
 * A stored answer carries its text and its last commenter, never the number of
 * people behind it, and any channel can deliver it again: a byte-exact
 * resubmission through MCP or the dashboard takes the same retry path the cron
 * takes. So the count is taken from the ticket rather than from whoever is
 * delivering, and the same answer is judged on the same evidence however it
 * arrives.
 *
 * The two ways that fails are not the same thing, and the caller acts on them
 * differently.
 *
 * "cannot_count" is temporary: nothing was read, or we could not learn our own
 * identity, so our own questions and nudges are indistinguishable from a
 * person's words. Neither says anything about how many people wrote, and a
 * later delivery may well be able to say.
 *
 * "evidence_gone" is permanent: the ticket WAS read, and the comments the
 * answer was composed from are not on it. A composed answer came from at least
 * one comment, so none left means they were deleted, and no retry brings them
 * back.
 */
type ComposedAuthorRecount = number | "cannot_count" | "evidence_gone";

async function recountComposedAuthors(input: {
  issueTracker: Pick<IssueTrackerAdapter, "getCurrentUserAccountId">;
  ticketKey: string | null;
  comments: readonly TicketComment[] | null;
  commentsCoverWindow: boolean;
  answererId: string;
  afterMs: number;
  throughMs: number;
}): Promise<ComposedAuthorRecount> {
  // No ticket, or a delivery that read none: a composed answer comes from a
  // ticket's comments, so without them there is nothing to count yet.
  if (!input.ticketKey || input.comments === null) return "cannot_count";
  // A read with a gap in the answer's own window answers neither question here.
  // It cannot say the evidence is gone, because what is missing from it may
  // simply be on a page nobody read; and it cannot be counted either, because
  // the comment that would make this two people's words is exactly the one a
  // gap hides. A read that cannot be vouched for is ignorance, and ignorance
  // decides nothing.
  if (!input.commentsCoverWindow) return "cannot_count";
  const botAccountId = await readBotAccountId(input.issueTracker, input.ticketKey);
  if (botAccountId === null) return "cannot_count";
  const count = composedAuthorCount(
    composedAnswerEvidence({
      comments: input.comments,
      botAccountId,
      afterMs: input.afterMs,
      throughMs: input.throughMs,
      authorAccountId: composedAnswerAccountId(input.answererId),
    }),
  );
  return count === 0 ? "evidence_gone" : count;
}

/** The actor id a Jira comment answer is attributed to. It is the durable mark
 *  of the one channel that composes an answer out of whatever several people
 *  wrote, it stays on the row, and it is written and read back through this
 *  pair so the two can never drift apart. */
const COMPOSED_ANSWER_ACTOR_PREFIX = "jira:";

export function composedAnswerActorId(accountId: string): string {
  return `${COMPOSED_ANSWER_ACTOR_PREFIX}${accountId}`;
}

export function isComposedAnswerActor(actorId: string | null | undefined): boolean {
  return (actorId ?? "").startsWith(COMPOSED_ANSWER_ACTOR_PREFIX);
}

/** The account behind a composed answer's actor id: whoever commented last, and
 *  therefore where the answer's own window closes. Only ever asked of an id the
 *  check above accepted. */
function composedAnswerAccountId(actorId: string): string {
  return actorId.slice(COMPOSED_ANSWER_ACTOR_PREFIX.length);
}

/** What an answer we decline to attribute is handed to the decision as, which
 *  leaves the trail row saying an answer arrived and writes no entry. Its own
 *  kind, rather than the one that means we could not read the words: the words
 *  here may be perfectly clear, and what is missing is whose they are. */
const DECLINED_ANSWER: WorkScopeQuestionAnswer = { kind: "unattributed" };

/**
 * What a refusal that never says what it is refusing is handed to the decision
 * as, when it arrived as a comment on a ticket.
 *
 * "unrecognised" rather than a kind of its own: it is what the decision already
 * does with words it will not act on, it writes the trail row and no entry, and
 * the sentence explaining this particular case goes where a person can read it,
 * on the ticket. "unattributed" would be a lie in the other direction, because
 * we know perfectly well who wrote this one.
 */
const UNADDRESSED_REFUSAL_ANSWER: WorkScopeQuestionAnswer = { kind: "unrecognised" };

/** Why a delivery is failed rather than delivered when the people behind a
 *  stored answer cannot be counted. It reaches a log and an HTTP response
 *  rather than the ticket, because a hold spends no delivery attempt and so
 *  never ends in the comment a spent budget posts. What the ticket is told,
 *  when the holding itself runs out, is `formatAnswerAuthorsUncountedComment`. */
const UNCOUNTED_AUTHORS_ERROR =
  "the people who wrote this answer could not be counted from the ticket";

/**
 * How long an answer may be held back because WE cannot count its authors.
 *
 * A hold spends none of the person's three resume attempts, so nothing else
 * bounds it: the row stays answered and every later delivery tries again. That
 * is right while the failure is a moment of Jira being unhelpful, and wrong
 * once it is not, because the run stays parked on an answer that was already
 * given. Fifteen minutes is several cron deliveries, which is as many chances
 * as a transient failure needs, and short enough that nobody waits on it.
 * Measured from the moment the answer was stored, so every delivery reads the
 * same deadline rather than restarting it.
 */
const UNCOUNTED_AUTHORS_HOLD_WINDOW_MS = 15 * 60 * 1000;

/**
 * What a delivery may do with the answer it is holding.
 *
 * "write" is the ordinary answer, with however many people are known to be
 * behind it (none known, on the channels that are one person by construction).
 * "hold" is our own inability to count, which this delivery must not go ahead
 * on. "no_write" is an answer that decides nothing and stops nothing: a question
 * about no repository, evidence that is gone for good, or counting that has had
 * its window and spent it, which is the one case the ticket is told about.
 */
type AnswerAuthorship =
  | { kind: "write"; authorCount?: number; tell?: AnswerNotRecordedReason }
  | { kind: "hold" }
  | { kind: "no_write"; tell?: AnswerNotRecordedReason };

/**
 * Decide and record a person's answer to a repository question, once, here,
 * where it arrives.
 *
 * The three answer channels all reach this function, and a run dies seconds
 * after an answer often enough that reading it later loses it: the next run
 * then asks the same question, which is the defect the work scope record exists
 * to end. So the answer becomes entries before the run wakes up, and the
 * resumed run reads those entries rather than the sentence.
 *
 * An `answered` decision reads neither the catalog's usability nor the trigger
 * policy, which is why this tier, which knows neither, may make it.
 *
 * A clarification that asked about no repository takes none of this: every
 * question that is not about repositories, and every question asked before this
 * shipped, behaves exactly as it did. An answer more than one person wrote
 * takes half of it: the trail keeps the row saying an answer arrived, and no
 * entry is written, for the reason at the guard below.
 *
 * Returns "hold" when the people behind the answer cannot be counted RIGHT NOW.
 * Nothing is written then, and the caller must not deliver either: a delivery
 * that can count is what this answer is waiting for. A hold costs the person
 * none of their delivery attempts, and is bounded by a window of its own.
 *
 * Two cases are not that, and both write nothing and deliver anyway: evidence
 * that is gone for good, which no later delivery would count, and a hold whose
 * window has run out, which says on the ticket that the failure was ours. The
 * person is better asked again than left on a run this cancelled.
 */
async function readAnswerAuthorship(input: {
  row: HookClarificationRow;
  answeredAt: Date;
  answerer: { id: string; label: string };
  authorCount?: number;
  issueTracker: Pick<IssueTrackerAdapter, "getCurrentUserAccountId">;
  ticketComments: readonly TicketComment[] | null;
  ticketCommentsCoverWindow: boolean;
}): Promise<AnswerAuthorship> {
  const askedRepositories = input.row.askedRepositories;
  // NO ASK AT ALL, WHICH IS NOT THE SAME AS AN ASK THAT LISTED NOTHING.
  //
  // A row with no asked list is a clarification that was not about repositories:
  // an agent asking which API shape to build, a plan waiting for approval. Its
  // answer is somebody's words on another subject entirely, and reading a
  // repository key out of "use Postgres, the pattern is in github:acme/api"
  // would record a decision nobody was asked to make. So it decides nothing,
  // and there is nothing to tell anybody about either.
  //
  // An EMPTY list is a repository question that named no repository, which is
  // the plain "which repository should this ticket modify?". That one is read,
  // and a person who answers it with a repository path has decided about that
  // repository (`packages/contracts/work-scope.ts`, where the two facts are
  // kept apart).
  if (askedRepositories === null || askedRepositories === undefined) {
    return { kind: "no_write" };
  }
  // Counted where the answer was composed, or counted again from the ticket,
  // and never guessed from which channel is delivering. A stored comment answer
  // comes back through any of them: resubmitting its exact text takes the same
  // resume retry path from the dashboard, from an MCP client and from the cron,
  // and none of those deliveries composed anything or carries a count. The
  // evidence they all share is the ticket the answer was composed from, so that
  // is what decides, and one answer is judged the same way however it arrives.
  const authorCount =
    input.authorCount === undefined && isComposedAnswerActor(input.answerer.id)
      ? await recountComposedAuthors({
          issueTracker: input.issueTracker,
          ticketKey: input.row.ticketKey,
          comments: input.ticketComments,
          commentsCoverWindow: input.ticketCommentsCoverWindow,
          answererId: input.answerer.id,
          afterMs: input.row.askedAt.getTime(),
          throughMs: input.answeredAt.getTime(),
        })
      : input.authorCount;

  // Counting is not the same as counting more than one, and only the second is
  // a decision. Our own identity unavailable, or a ticket nobody read, says
  // nothing at all about how many people answered, and the write here happens
  // once per clarification, so spending it on a moment of Jira being unhelpful
  // would unrecord a good answer for good. Decide nothing, and hand the caller a
  // delivery to fail rather than a resume to perform, so the answer is still
  // there for a delivery that can count it.
  if (authorCount === "cannot_count") {
    // Held, but not forever. A hold costs the person nothing, which is the
    // point of it standing outside the resume budget, and that is exactly why
    // it needs a bound of its own: an identity endpoint that is down for good,
    // or a ticket too long to read to the end, would otherwise leave the run
    // parked with a delivered answer nobody is waiting on any more. The bound
    // runs from the moment the answer was stored, so it is the same window
    // however many deliveries try inside it.
    const heldForMs = Date.now() - input.answeredAt.getTime();
    if (heldForMs < UNCOUNTED_AUTHORS_HOLD_WINDOW_MS) {
      logger.warn(
        { runId: input.row.runId, clarificationId: input.row.id },
        "work_scope_answer_not_counted",
      );
      return { kind: "hold" };
    }
    logger.warn(
      { runId: input.row.runId, clarificationId: input.row.id, heldForMs },
      "work_scope_answer_not_counted_gave_up",
    );
    // The ticket is told, because the person gave a good answer and something
    // they cannot see decided not to keep it. The caller posts it, once the
    // delivery it belongs to is the one going ahead.
    return { kind: "no_write", tell: "uncounted" };
  }

  // The other half of that, and the opposite conclusion. The ticket was read
  // and the comments the answer was composed from are gone: there is no later
  // delivery that counts them, so holding the answer back only spends the
  // delivery budget and ends in a cancelled run and a sentence nobody can act
  // on. Nothing is written, the resume goes through on the words the person
  // already saw, and the next run asks the question again. A repeated question
  // is a cost; a run cancelled on somebody who answered correctly is worse.
  if (authorCount === "evidence_gone") {
    logger.warn(
      { runId: input.row.runId, clarificationId: input.row.id },
      "work_scope_answer_evidence_gone",
    );
    // And said on the ticket. The question comes back on the next run, and a
    // person who is asked twice is owed the reason both times.
    return { kind: "no_write", tell: "evidence_gone" };
  }

  if (authorCount === undefined) return { kind: "write" };
  // Written, and written as a decline: the entries are the record's business
  // and the sentence is the person's. Several people wrote these words, so the
  // record keeps none of them as anybody's decision, and the person who
  // answered would otherwise see only the same question again.
  return authorCount > 1
    ? { kind: "write", authorCount, tell: "several_authors" }
    : { kind: "write", authorCount };
}

/**
 * Write what the answer decided, with the authorship already established.
 *
 * Separate from the counting above because the two happen at different moments
 * in a delivery: counting decides whether this delivery may go ahead at all, and
 * must cost nothing when it cannot; writing is a side effect, and belongs where
 * every other side effect of a committed delivery is, behind the reservation
 * that proves this delivery is the one going ahead.
 */
async function recordRepositoryAnswer(
  persistence: AnswerPersistence,
  input: {
    row: HookClarificationRow;
    answer: string;
    answeredAt: Date;
    answerer: { id: string; label: string };
    authorCount?: number;
  },
): Promise<AnswerNotRecordedReason | undefined> {
  const askedRepositories = input.row.askedRepositories ?? [];
  const authorCount = input.authorCount;

  // Words several people wrote together decide nothing (A50). The ticket
  // channel composes its answer out of every comment posted after the
  // question, whether or not anybody was answering, so a colleague's aside
  // arrives inside the answer with nothing marking it apart. Read as one
  // person's decision it writes two entries nobody can undo: the repository
  // the aside happened to name, selected in their name, and the repository we
  // asked about, refused for not having been named. The run resumes on the
  // same words either way; only the entries are declined, so the next run asks
  // again. A repeated question is a cost, a fabricated decision is a defect.
  //
  // The count is a number from the comments themselves. It is never recovered
  // from the answer, because the answer does not say: a person whose own line
  // opens "reason:" is still one person, and a display name carrying a colon is
  // still one author.
  //
  // A warning rather than a note, because anything commenting after our
  // question counts as a second author: one Jira automation rule firing on the
  // move into the AI column would decline every answer on every ticket, and the
  // only symptom anybody sees is the question being asked twice.
  const declined = authorCount !== undefined && authorCount > 1;
  if (declined) {
    logger.warn(
      {
        runId: input.row.runId,
        clarificationId: input.row.id,
        authorCount,
      },
      "work_scope_answer_not_attributed_multiple_authors",
    );
  }
  const catalog = await persistence.repositoryCatalog();
  const askedKeys = askedRepositories.map((repository) => repository.repositoryKey);
  // What counts as a repository this deployment has: the catalog, plus whatever
  // the question itself named, because a question naming a key the catalog has
  // since dropped is still this deployment asking about it. One list, read by
  // the reader below and by the sentence at the end, so the two cannot disagree
  // about which names we hold.
  const catalogKeys = [...new Set([...catalog.keys, ...askedKeys])];
  // A declined answer is not read at all, which is the point: the words may be
  // perfectly readable, they are simply not one person's decision to record.
  const answerRead = declined
    ? DECLINED_ANSWER
    : readRepositoryAnswer(withoutComposedAuthors(input.answer), {
        catalogKeys,
        askedKeys,
        // What we asked is the only part of this exchange we know for certain,
        // and the reader needs it: Jira's quote button sends our own question
        // back inside the answer with no marker on it, and the repository key
        // in it is ours, not the person's.
        askedQuestions: input.row.questions,
      });

  // A PLAIN NO ON A TICKET IS NOT EVIDENCE THAT ANYBODY ANSWERED US.
  //
  // What a refusal writes is the heaviest thing in this feature: every
  // repository the question named, left out in that person's name, and an
  // exclusion never expires. What it rests on, when it arrives through the
  // ticket, is a comment posted in a window. Nothing threads it to our
  // question. A colleague replying "no" to the comment above ours, or a Jira
  // rule configured to comment as a named user, is read as that person
  // declining every repository we asked about, and nobody typed a word about
  // repositories.
  //
  // So the evidence has to match the weight. A refusal that says what it
  // refuses ("none of these", "no more repositories", "continue without it")
  // could not be about anything else, and is recorded exactly as before. A bare
  // "no" is recorded as nothing, the person is told why in a comment that says
  // what to write instead, and the question comes again. That is the ordering
  // this feature is built on: a repeated question is a cost, a decision nobody
  // made is a defect (A34).
  //
  // Which phrases reach which way is decided where the phrases are declared
  // (`REFUSAL_ANSWERS` in `engine/repository-discovery/runner.ts`), and read
  // here rather than worked out again. There is only one list, and the type of
  // its values is what stops a new phrase joining it undecided.
  //
  // Narrow on purpose, in three ways. Only the ticket channel, because the
  // dashboard and the MCP client type into a box opened by this question and a
  // "no" there is unmistakably an answer to it. Only a question that put
  // repositories in front of somebody, because a refusal to any other decides
  // nothing to begin with (`decideAnswered` writes for an asked repository the
  // question named, and nothing at all for one it did not or for a `selection`
  // ask, so there is no permanent write here to raise the bar for and nothing
  // to tell anybody about). And only a refusal: an answer naming
  // repositories is its own evidence, since nobody types a repository path by
  // accident.
  const refusalDecidesNothing =
    answerRead.kind === "none" &&
    isComposedAnswerActor(input.answerer.id) &&
    askedRepositories.some(
      (repository) => repository.named === true && repository.askedBecause !== "selection",
    ) &&
    !refusalNamesRepositories(withoutComposedAuthors(input.answer));
  if (refusalDecidesNothing) {
    // A warning, for the same reason the declined count is one: from the
    // outside this looks exactly like the question being asked twice.
    logger.warn(
      { runId: input.row.runId, clarificationId: input.row.id },
      "work_scope_answer_refusal_not_addressed",
    );
  }
  const answer = refusalDecidesNothing ? UNADDRESSED_REFUSAL_ANSWER : answerRead;
  // There is no branch here for a subject that could not be found, and none is
  // missing. The clarification row names the subject the question was asked
  // under, and a row without one cannot be read at all
  // (`db/repositories/clarification-hooks.ts:33` refuses it), so the key below
  // always exists. A subject with no row in `work_scopes` is not a subject
  // nobody can name either: it is one nobody has decided anything about yet,
  // and this answer is the first decision, which is what creates the record. A
  // gate on that emptiness would drop exactly the first answer on a ticket,
  // which is the answer this function exists to keep.
  const scope = await persistence.readWorkScope(input.row.subjectKey);
  const decision = decideWorkScope(
    {
      scope,
      carriesRecord: true,
      // Enabled is all this path can see: it holds no provider listing, so it
      // cannot tell enabled from usable and says so by passing no unusable
      // keys (A26).
      //
      // SO AN ENTRY WRITTEN HERE MAY NAME A REPOSITORY THIS DEPLOYMENT CANNOT
      // REACH. Null means this path never listed the repositories rather than
      // that it listed them and found them all usable (`engine/work-scope/
      // context.ts`), and getting a listing would turn answering a question
      // into a provider API call. It is the reader that keeps such a key from
      // doing harm: a person-origin selection only closes the matter when the
      // run can actually reach it (`decideTextAmbiguous` in
      // `engine/work-scope/decide.ts`), so an unreachable one is recorded, the
      // run refuses it, the question is still asked, and the person can
      // correct it. The entry is a person's decision either way, and deleting
      // it because today's deployment cannot act on it would be us overruling
      // them.
      catalog: {
        activated: catalog.activated,
        enabledKeys: catalog.enabledKeys,
        unusableKeys: null,
      },
      // The definition pin, the trigger policy, the workspace and the selection
      // flag each bound what a RUN may do with repositories. A person's answer
      // is bounded by none of them, and an `answered` event reads none of them.
      pinnedProviders: null,
      pinnedKeys: null,
      policy: null,
      eventRelatedKeys: [],
      attachedKeys: null,
      selectionAnswered: false,
      actor: {
        kind: "person",
        actorId: input.answerer.id,
        actorLabel: input.answerer.label,
      },
      now: input.answeredAt.toISOString(),
    },
    { kind: "answered", clarificationId: input.row.id, asked: askedRepositories, answer },
  );
  // Not caught. A swallowed write is the lost answer this record exists to
  // prevent, wearing a smile: the caller reports the failure, the channel
  // delivers the same answer again, and the answer-once index applies it once.
  await persistence.applyAnswerWorkScope({
    subjectKey: input.row.subjectKey,
    runId: input.row.runId,
    clarificationId: input.row.id,
    plan: decision.plan,
  });
  if (refusalDecidesNothing) return "unaddressed_refusal";

  // NOBODY IS ASKED SOMETHING THEY HAVE ALREADY ANSWERED WITHOUT BEING TOLD WHY.
  //
  // An answer can be read, be nobody's fault, and still leave the record exactly
  // as it found it: a "no" to "which repository should this ticket modify?"
  // names nothing, and a question that listed no repository has nothing to
  // record a refusal against either. The run resumes, finds nothing selected,
  // and puts the same question again. Without a sentence here the person sees
  // their answer vanish and the question return, over and over, until the
  // delivery attempts run out, which is the loop this feature exists to end.
  //
  // What silences a repository question is not a guess about the future: it is
  // one of exactly two reads over the trail this answer just wrote
  // (`db/repositories/work-scope.ts`). `readWorkScopeSelectionAnswered` raises a
  // permanent flag for the subject as soon as a `selection` question is
  // answered at all, so that question is settled whatever it recorded and
  // saying otherwise would name a fault that is not there.
  // `readWorkScopeAnsweredRepositories` suppresses the repositories a question
  // NAMED once it has an answer, and a question that named none suppresses
  // nothing. So an empty-handed plan with no `selection` ask behind it means the
  // question is coming back. The sentence says MAY come back rather than WILL,
  // which keeps it true in the one case this cannot see: a key whose entry the
  // origin ladder refused is suppressed all the same.
  const recordKeptNothing = decision.plan.upserts.length === 0 && decision.plan.deletes.length === 0;
  const settledByAnsweringAtAll = askedRepositories.some(
    (repository) => repository.askedBecause === "selection",
  );
  if (!recordKeptNothing || settledByAnsweringAtAll) return undefined;
  // An answer with no word in it is its own case, because the RUN does
  // something with it that nothing else here does: `isRefusalAnswer` takes the
  // wordless branch and ends the asking, so the run carries on without the
  // repository it asked about while the record writes nothing. Asked of the
  // stored answer exactly as the run reads it, prefixes and all, so the two
  // never disagree about which branch was taken. A thumbs up posted as a Jira
  // comment arrives here as "Jane: (thumbs up)", which HAS words, and the run
  // asks its follow-up instead; that one is told the ordinary sentence, which
  // is the truthful one for it.
  if (hasNoWords(input.answer)) return "no_words";
  // WHICH OF THE TWO WAYS AN ANSWER NAMES NOTHING. Both end here with an empty
  // record, and only one of them leaves "write the full path in a comment" true.
  // A person who wrote a bare or partial name can write it out in full and the
  // next run resolves it; a person who already wrote `github:acme/thing` in
  // full, for a repository this deployment does not hold, would write the same
  // words for the next run to resolve to the same nothing.
  return namedOnlyRepositoriesWeDoNotHold({
    answer: withoutComposedAuthors(input.answer),
    askedQuestions: input.row.questions,
    catalogKeys,
  })
    ? "no_such_repository"
    : "no_repository_named";
}

/**
 * True when everything the person spelled out as a repository path names
 * something this deployment has no record of at all.
 *
 * ASKED HERE RATHER THAN READ OFF THE ANSWER, and deliberately so: the reader
 * collapses both cases into `unrecognised`, because for the RECORD they are the
 * same fact (nothing to write). They differ only in what is true to tell
 * somebody, which is this function's caller's question. Widening the reader's
 * verdict would change a contract two lanes read, at freeze time, to serve one
 * sentence.
 *
 * A PREDICATE, NOT A THIRD RESOLVER. It asks whether the catalog holds anything
 * by that name, not which key it resolves to, so it cannot disagree with
 * `resolveIdentity` in a way that matters: a bare path present on two providers
 * is ambiguous there and held here, and held is the right answer for the
 * sentence, because writing that one provider-scoped does resolve.
 *
 * No identity at all means prose or a bare word, which is the case the ordinary
 * sentence is written for. One answer carrying both shapes gets this one, which
 * is the fuller explanation and still true for them.
 */
function namedOnlyRepositoriesWeDoNotHold(input: {
  answer: string;
  askedQuestions: string[];
  catalogKeys: RepositoryKey[];
}): boolean {
  // Our own question quoted back is not the person naming anything, which is
  // the same drop the reader makes before it reads a word.
  const identities = parseRepositoryExpansionAnswer(
    withoutQuotedQuestions(input.answer, input.askedQuestions),
  );
  if (identities.length === 0) return false;
  const held = new Set(input.catalogKeys);
  const heldPaths = new Set(input.catalogKeys.map((key) => key.slice(key.indexOf(":") + 1)));
  return identities.every((identity) =>
    identity.provider
      ? !held.has(repositoryCatalogKey({ provider: identity.provider, path: identity.repoPath }))
      : !heldPaths.has(identity.repoPath.toLowerCase()),
  );
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
