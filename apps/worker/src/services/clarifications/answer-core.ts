// Static import so route tests can vi.mock("workflow/api"): a dynamic import
// would bypass the module mock and hit the real Workflow runtime.
import {
  MAX_CLARIFICATION_ANSWER_LENGTH,
  repositoryCatalogKey,
  type RepositoryKey,
  type SettingsSnapshot,
  type WorkScope,
  type WorkScopeWritePlan,
} from "@shared/contracts";
import { getHookByToken, resumeHook } from "workflow/api";
import { env } from "../../infra/vcs-config.js";
import { HookNotFoundError } from "workflow/errors";
import type { Db } from "../../db/types.js";
import { readRepositoryAnswer } from "../../engine/work-scope/answer.js";
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
 */
type AnswerClarificationInput = {
  row: HookClarificationRow;
  rawAnswer: string;
  actor: { id: string; label: string };
  issueTracker: Pick<IssueTrackerAdapter, "fetchTicket" | "moveTicket" | "postComment">;
  skipTicketFetch?: boolean;
  skipTicketMove?: boolean;
  skipAnswerComment?: boolean;
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
  await recordRepositoryAnswer(persistence, { row, answer, answeredAt, answerer });

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
 *  (`services/clarifications/resume-from-comments.ts:269-271`). The separator
 *  and the pattern are the ones the expansion protocol's refusal reader applies
 *  to the same text (`engine/repository-discovery/runner.ts:903-904`), so one
 *  answer is never cut two ways. The space after the colon is what keeps
 *  "github:acme/web" from reading as an author. */
const COMPOSED_COMMENT_SEPARATOR = "\n\n";
const COMPOSED_AUTHOR_PREFIX = /^[^:\n]+: /;

/**
 * The answer with each comment's composed author taken off the front of it, and
 * every other byte kept: what the person wrote is the answer. Without this a
 * bare reply of "api, web" arrives as "Filip Maszota: api, web" and names
 * nobody the reader knows.
 *
 * Per comment, never per line. The author is written once, in front of the
 * FIRST line of a comment, and every line under it is the person's own: someone
 * answering "api: the backend" on the second line means that repository, and
 * taking the name off there would hand the reader prose and get them asked the
 * same question again. The pattern cannot cross a newline, so applying it to
 * the whole comment already reaches only its first line.
 */
function withoutComposedAuthors(answer: string): string {
  return answer
    .split(COMPOSED_COMMENT_SEPARATOR)
    .map((comment) => comment.replace(COMPOSED_AUTHOR_PREFIX, ""))
    .join(COMPOSED_COMMENT_SEPARATOR);
}

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
 * shipped, behaves exactly as it did.
 */
async function recordRepositoryAnswer(
  persistence: AnswerPersistence,
  input: {
    row: HookClarificationRow;
    answer: string;
    answeredAt: Date;
    answerer: { id: string; label: string };
  },
): Promise<void> {
  const askedRepositories = input.row.askedRepositories;
  if (!askedRepositories || askedRepositories.length === 0) return;
  const catalog = await persistence.repositoryCatalog();
  const askedKeys = askedRepositories.map((repository) => repository.repositoryKey);
  const answer = readRepositoryAnswer(withoutComposedAuthors(input.answer), {
    catalogKeys: [...new Set([...catalog.keys, ...askedKeys])],
    askedKeys,
    // What we asked is the only part of this exchange we know for certain, and
    // the reader needs it: Jira's quote button sends our own question back
    // inside the answer with no marker on it, and the repository key in it is
    // ours, not the person's.
    askedQuestions: input.row.questions,
  });
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
