// Static import so route tests can vi.mock("workflow/api"): a dynamic import
// would bypass the module mock and hit the real Workflow runtime.
import {
  MAX_CLARIFICATION_ANSWER_LENGTH,
  repositoryCatalogKey,
  type RepositoryKey,
  type SettingsSnapshot,
  type WorkScopeAnswerReading,
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
  answerAsWritten,
  recordRepositoryAnswer,
  type AnswerReadingDeps,
  type RepositoryAnswerPersistence,
  type RepositoryAnswerOutcome,
} from "../work-scope/index.js";
import {
  answerReadingConfirmMessage,
  readAnswerForRow,
  repositoryQuestionOfRow,
} from "./answer-reading.js";
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
  type IssueTrackerMoveTarget,
  type TicketComment,
} from "../../adapters/issue-tracker/types.js";
import { logger } from "../../infra/logger.js";
import { aiColumnMoveTarget } from "../tickets/index.js";
import {
  markConnectedRunResumed,
  markRunResumed,
} from "../../db/repositories/runs/telemetry.js";
import {
  moveConnectedTicketForRun,
  moveTicketForRun,
  withdrawConnectedTicketFromAiForRun,
  withdrawTicketFromAiForRun,
} from "../tickets/index.js";
import {
  formatAnswerNotRecordedComment,
  formatAnswerAlsoNamedComment,
  formatAnswerDeclinedComment,
  formatAnswerDelegatedComment,
  formatAnswerNotOfferedComment,
  formatAnswerLeftOutComment,
  formatClarificationAnswerComment,
  aLaterRunCanPickUpAskedRepositories,
  type ClarificationAnswerSurfaceComment,
} from "./comment-format.js";
import {
  answerConnectedHookClarification,
  answerHookClarification,
  recordConnectedUnreadableHookClarificationAnswer,
  recordUnreadableHookClarificationAnswer,
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
import { retireConnectedClarificationForGoneTicket } from "../../db/repositories/clarifications.js";
import { commentPathAfterAnUnrecordedAnswer } from "../../engine/work-scope/context.js";
import {
  findBoundActiveRunOwner,
  findConnectedBoundActiveRunOwner,
} from "../../db/repositories/active-runs.js";
import { retireClarificationForGoneTicket } from "./retirement.js";
import {
  recordAnswerDelivery,
  type AnswerDeliveryRecord,
} from "../agent-visibility/index.js";
import { createAuthRepository, getConnectedDashboardUserLabel } from "../../db/repositories/auth.js";

/** Re-exported under the name this cluster has always used. The number itself
 *  belongs to the contracts package, which is also what the request schema and
 *  the MCP tool catalogue read, so no channel can judge an answer by a different
 *  limit than the one a client was told. */
export const MAX_ANSWER_LENGTH = MAX_CLARIFICATION_ANSWER_LENGTH;

export type AnswerClarificationOutcome =
  | {
      kind: "answered";
      row: HookClarificationRow;
      /**
       * What this answer did to the repository record, in one sentence for the
       * person who wrote it, and absent when it recorded exactly what it named.
       *
       * THE PERSON WHO ANSWERED HAS TO LEARN IT IN THE CHANNEL THEY ANSWERED
       * IN. The ticket comment reaches the ticket's readers, and somebody
       * answering from the dashboard or an MCP client may never open it; they
       * see "answered", and the next run asks them the same question. The
       * delivery is unaffected either way: the answer reached the run, and this
       * is what happened to the record beside it.
       *
       * ONE FIELD FOR EVERYTHING THE PERSON IS TOLD about the record. It says
       * that the answer recorded no repository decision (the same words the
       * ticket comment carries), or which listed repositories it declined and
       * how to bring one back, or which repositories the workflow took when
       * they asked it to decide, and it may add a second sentence about a
       * repository they named that the question did not list. It is composed
       * once and read in one place by every channel: a reader that had to
       * branch on which of several fields arrived would be a second rule to
       * keep in step. Show it as text; do not parse it.
       *
       * The composed TEXT rather than a code, on purpose. The code is an
       * internal classification whose only job is choosing these words, and a
       * second vocabulary on the wire is a second thing to keep in step: a
       * surface rendering its own sentence per code would drift from the ticket,
       * and a person reading both would meet two stories about one answer.
       */
      recordOutcome?: string;
    }
  | { kind: "invalid_answer" }
  /**
   * The answer arrived and could not be read, so NOTHING happened to it.
   *
   * The question is still pending, the run is still parked on its hook and no
   * resume attempt was spent. The ticket is never moved INTO the AI column; on
   * the first telling one that sits there is put back in the backlog, where it
   * waited when the question was asked (`withdrawTicketWhileQuestionWaits`).
   * `confirm` is what the person is told, in the channel they answered through:
   * what we read, that nothing was recorded, the one reply that ends the
   * exchange, and where the ticket waits when this delivery moved it.
   *
   * THE COST IS DELIBERATE and the owner chose it: an ambiguous answer leaves
   * the run parked until that person replies or the question expires. The
   * alternative is resuming into a run that will fail or, worse, recording a
   * decision in the name of somebody who said something else.
   */
  | { kind: "answer_unclear"; confirm: string }
  | { kind: "conflict" }
  | { kind: "resume_terminal" }
  | { kind: "ticket_gone" }
  | { kind: "ticket_transition_failed"; error: unknown }
  | { kind: "resume_failed_retryable"; error: unknown }
  | { kind: "resume_exhausted"; error: unknown };

interface AnswerPersistence extends RepositoryAnswerPersistence {
  findBoundOwner(input: { subjectKey: string; runId: string }): Promise<{ ownerToken: string } | null>;
  transitionTicket(input: {
    issueTracker: Pick<IssueTrackerAdapter, "fetchTicket" | "moveTicket">;
    ticketKey: string;
    target: ReturnType<typeof aiColumnMoveTarget>;
    owner: { subjectKey: string; ownerToken: string; runId: string };
  }): Promise<void>;
  /** Move the ticket out of the AI column only if a fresh read still finds it
   *  there, behind the same owner fence, and say whether this call moved it. */
  withdrawTicketFromAi(input: {
    issueTracker: Pick<IssueTrackerAdapter, "fetchTicket" | "moveTicket">;
    ticketKey: string;
    aiColumn: IssueTrackerMoveTarget;
    target: IssueTrackerMoveTarget;
    owner: { subjectKey: string; ownerToken: string; runId: string };
    requiredOwnerState: "bound";
  }): Promise<boolean>;
  answer(
    id: string,
    answer: string,
    actor: { id: string; label: string },
    reading?: WorkScopeAnswerReading,
  ): Promise<HookClarificationRow | null>;
  /** Keep an unreadable answer and its reading without answering the question:
   *  the row stays pending and the run stays parked. */
  recordUnreadable(id: string, answer: string, reading: WorkScopeAnswerReading): Promise<void>;
  reserve(id: string, answeredAt: Date): Promise<ResumeAttemptReservation | null>;
  finishFailed(input: {
    row: HookClarificationRow;
    reservation: ResumeAttemptReservation;
    issueTracker: Pick<IssueTrackerAdapter, "fetchTicket" | "moveTicket" | "postComment">;
    error: unknown;
  }): Promise<"retryable" | "exhausted" | "lost">;
  retireGoneTicket(row: HookClarificationRow): Promise<void>;
  markResumed(runId: string): Promise<void>;
  /** Keep this arrival of the answer. Never fails a delivery: it returns an
   *  outcome and logs its own losses. */
  recordDelivery(delivery: AnswerDeliveryRecord): Promise<unknown>;
  /** Whoever is behind a user id, for the ticket comment an MCP answer posts,
   *  or null when the deployment cannot say. */
  personLabel(userId: string): Promise<string | null>;
}

/**
 * A label that is only the id again is no name a person would recognise, and
 * an email address is not something to publish: the ticket may be a client's,
 * and the person behind an MCP client never agreed to have their address
 * posted there. Anonymous beats leaked.
 */
function namedPerson(label: string, userId: string): string | null {
  const trimmed = label.trim();
  return trimmed.length > 0 && trimmed !== userId && !trimmed.includes("@") ? trimmed : null;
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

/**
 * Bring a parked ticket back to the configured AI column so its status matches
 * the run that is about to wake up. Rides the asking run's own subject claim:
 * the run still holds it while suspended on the hook, so the same owner fence
 * that guards every other run-driven move guards this one. A missing bound
 * claim means no run can work this ticket, so it must not be moved either;
 * that is logged, not raised, because the answer itself is still legitimate.
 */
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
 * Put the ticket of an answer nobody could read back in the backlog column,
 * where it waited when the question was asked, and say whether it moved.
 *
 * Moving the ticket into the AI column after replying is the commit gesture the
 * question asks for. A reply that commits nothing leaves the run parked, and a
 * ticket left in AI tells everybody looking at the board that the agent is
 * working when the run is waiting for a person.
 *
 * The owner fence every run-driven move rides: without a bound claim no run
 * holds this ticket, so it is not moved, and that is logged rather than raised.
 * Best effort in the strongest sense: the person still has to be told their
 * answer was not read, so a failure here is logged and the note says nothing
 * about the column.
 *
 * WHETHER IT MOVED, as the withdraw reports it, rather than whether it
 * returned. It reads the ticket again inside the fence and quietly leaves alone
 * one that has already left the AI column (a person moved it on in the
 * meantime), and the note must not claim a move that did not happen.
 */
async function withdrawTicketWhileQuestionWaits(input: {
  persistence: AnswerPersistence;
  issueTracker: Pick<IssueTrackerAdapter, "fetchTicket" | "moveTicket">;
  ticketKey: string;
  row: HookClarificationRow;
  columns: Pick<SettingsSnapshot, "COLUMN_AI" | "COLUMN_BACKLOG">;
}): Promise<boolean> {
  const { ticketKey, row, columns } = input;
  try {
    const owner = await input.persistence.findBoundOwner({
      subjectKey: row.subjectKey,
      runId: row.runId,
    });
    if (!owner) {
      logger.warn(
        { ticketKey, runId: row.runId },
        "work_scope_answer_unclear_withdraw_skipped_no_bound_owner",
      );
      return false;
    }
    return await input.persistence.withdrawTicketFromAi({
      issueTracker: input.issueTracker,
      ticketKey,
      aiColumn: columns.COLUMN_AI,
      target: env.JIRA_BACKLOG_TRANSITION_ID
        ? { name: columns.COLUMN_BACKLOG, transitionId: env.JIRA_BACKLOG_TRANSITION_ID }
        : columns.COLUMN_BACKLOG,
      owner: { subjectKey: row.subjectKey, ownerToken: owner.ownerToken, runId: row.runId },
      requiredOwnerState: "bound",
    });
  } catch (error) {
    logger.warn(
      { ticketKey, runId: row.runId, err: (error as Error).message },
      "work_scope_answer_unclear_withdraw_failed",
    );
    return false;
  }
}

/**
 * Which channel this delivery came through, stated by that channel.
 *
 * NEVER GUESSED FROM A LABEL. An MCP client signs its answers "MCP
 * <clientId>" and a dashboard user may be called anything, so a reader of the
 * record, and the person reading the ticket comment, learn the truth only if
 * the caller says it. The MCP surface carries the client and whoever is behind
 * it, because the ticket comment names both.
 */
type AnswerClarificationSurface =
  | { kind: "jira" }
  | { kind: "dashboard" }
  | { kind: "mcp"; clientId: string; userId: string | null };

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
  /** Where these words arrived from. */
  surface: AnswerClarificationSurface;
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
  /** The model that reads a repository answer, injected so tests can drive the
   *  reading without a provider. Production passes nothing and gets the small
   *  default model. */
  answerReadingDeps?: AnswerReadingDeps;
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
    withdrawTicketFromAi: (withdraw) => withdrawTicketFromAiForRun({ db, ...withdraw }),
    answer: (id, answer, actor, reading) => answerHookClarification(db, id, answer, actor, reading),
    recordUnreadable: (id, answer, reading) =>
      recordUnreadableHookClarificationAnswer(db, id, answer, reading),
    reserve: (id, answeredAt) => reserveResumeAttempt(db, id, answeredAt),
    finishFailed: (failed) =>
      finishFailedResume({ db, settings: input.cancelSettings, ...failed }),
    retireGoneTicket: (row) => retireClarificationForGoneTicket(db, row),
    markResumed: (runId) => markRunResumed(db, runId),
    recordDelivery: (delivery) => recordAnswerDelivery(delivery, { db }),
    personLabel: async (userId) => {
      try {
        return namedPerson(await createAuthRepository(db).dashboardUserLabel(userId), userId);
      } catch {
        return null;
      }
    },
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
    withdrawTicketFromAi: withdrawConnectedTicketFromAiForRun,
    answer: answerConnectedHookClarification,
    recordUnreadable: recordConnectedUnreadableHookClarificationAnswer,
    reserve: reserveConnectedResumeAttempt,
    finishFailed: (failed) =>
      finishConnectedFailedResume({ settings: input.cancelSettings, ...failed }),
    retireGoneTicket: retireConnectedClarificationForGoneTicket,
    markResumed: markConnectedRunResumed,
    recordDelivery: (delivery) => recordAnswerDelivery(delivery),
    personLabel: async (userId) => {
      try {
        return namedPerson(await getConnectedDashboardUserLabel(userId), userId);
      } catch {
        return null;
      }
    },
    repositoryCatalog: loadConnectedRepositoryCatalogKeys,
    readWorkScope: readConnectedWorkScope,
    applyAnswerWorkScope: applyConnectedAnswerWorkScopePlan,
  });
}

/**
 * WHAT ARRIVED FROM A PERSON, filled in as this delivery goes, and written
 * once when it is over.
 *
 * Written whatever the delivery then did: an answer that lost the CAS or whose
 * ticket move failed still arrived, and "I answered three times and nothing
 * happened" is exactly the question these rows exist to answer. The round's
 * effects say what the record did with it.
 */
interface AnswerArrival {
  /** False for words that never reached the question: an empty answer, and a
   *  resume retry, which is our own redelivery of words already recorded. */
  record: boolean;
  authorDisplay: string;
  authorCount: number | undefined;
  reading: WorkScopeAnswerReading | null;
  /** What the person was told, in the channel they answered through, and only
   *  once it really reached them. */
  note: string | null;
}

async function answerClarificationAndResumeWithPersistence(
  input: AnswerClarificationInput,
  persistence: AnswerPersistence,
): Promise<AnswerClarificationOutcome> {
  const arrival: AnswerArrival = {
    record: false,
    authorDisplay: input.actor.label,
    authorCount: input.answerAuthorCount,
    reading: null,
    note: null,
  };
  try {
    return await deliverAnswer(input, persistence, arrival);
  } finally {
    if (arrival.record) {
      // NEVER ABLE TO CHANGE WHAT THIS ANSWER DID. `recordAnswerDelivery`
      // catches its own failures, and this catches whatever a persistence
      // beyond it could still throw: the same status, the same resume, the
      // same comments and the same reply, whatever the record of the arrival
      // costs.
      try {
        await persistence.recordDelivery({
          clarificationId: input.row.id,
          runId: input.row.runId,
          words: input.rawAnswer.trim(),
          author: {
            kind: (arrival.authorCount ?? 1) > 1 ? "several_people" : "person",
            display: arrival.authorDisplay,
          },
          surface: input.surface.kind,
          reading: arrival.reading,
          note: arrival.note,
        });
      } catch (error) {
        logger.warn(
          {
            runId: input.row.runId,
            clarificationId: input.row.id,
            err: (error as Error).message,
          },
          "clarification_answer_delivery_failed",
        );
      }
    }
  }
}

async function deliverAnswer(
  input: AnswerClarificationInput,
  persistence: AnswerPersistence,
  arrival: AnswerArrival,
): Promise<AnswerClarificationOutcome> {
  const { row, rawAnswer, actor, issueTracker } = input;

  const answer = rawAnswer.trim();
  const isResumeRetry = row.status === "answered" && row.answer === answer;
  // Whoever is behind an MCP client, where the deployment knows them: read
  // once, and used both for the record of the arrival and for the ticket
  // comment, so neither of them signs a person's answer with an OAuth client
  // id alone.
  const mcpPerson =
    input.surface.kind === "mcp" && input.surface.userId
      ? await persistence.personLabel(input.surface.userId)
      : null;
  const displayOf = (label: string) => (mcpPerson ? `${mcpPerson} (${label})` : label);

  // AN ARRIVAL IS WHAT A PERSON SENT, whatever we then do with it.
  //
  // Set before the refusals below, because an answer too long to take, an
  // answer that lost the race to another one and an answer to a question whose
  // resume is already spent are exactly the deliveries a person comes looking
  // for: they said something and nothing happened. The round shows each of
  // them with no effects.
  //
  // A RESUME RETRY IS NOT AN ARRIVAL. The cron redelivers the stored answer to
  // a run whose resume was lost; recording that as a delivery would credit the
  // person who answered in the dashboard with a Jira delivery they never made,
  // and count our retries as their words. Nor is empty text: nothing arrived.
  arrival.record = answer.length > 0 && !isResumeRetry;
  arrival.authorDisplay = displayOf(actor.label);

  if (!answer || answer.length > MAX_ANSWER_LENGTH) {
    return { kind: "invalid_answer" };
  }
  if (row.status === RESUME_FAILED_STATUS) return { kind: "resume_terminal" };
  if (row.status !== "pending" && !isResumeRetry) {
    return { kind: "conflict" };
  }

  const answerer = isResumeRetry
    ? { id: row.answeredById ?? actor.id, label: row.answeredByLabel ?? actor.label }
    : actor;
  arrival.authorDisplay = displayOf(answerer.label);
  // Which channel this answer came from, and it is the mark the composer put on
  // the actor rather than a guess: only the ticket path composes an answer out
  // of comments. Three things below read it, the reading, the record and the
  // decline sentence, so it is decided once.
  const composedFromComments = isComposedAnswerActor(answerer.id);

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
  // And the column the ticket stands in, from the same read, for the one branch
  // below that has to know it: an answer nobody could read takes a ticket it
  // finds in the AI column back to the backlog.
  let ticketStatus: string | null = null;
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
      ticketStatus = ticket.trackerStatus;
    } catch (err) {
      if (!(err instanceof IssueTrackerNotFoundError)) throw err;
      await persistence.retireGoneTicket(row);
      return { kind: "ticket_gone" };
    }
  }

  // HOW THESE WORDS WERE READ, DECIDED ONCE, BEFORE ANYTHING IS COMMITTED.
  //
  // Here rather than beside the record, for two reasons that are really one.
  // The record and the resumed run each used to read the answer text for
  // themselves and reach opposite conclusions about the same sentence ("yes" to
  // a question about one repository was a selection to one and noise to the
  // other), so there is now one reading and both consume it. And an answer
  // nobody can read must leave no trace at all, which is only possible while
  // the row is still pending, the ticket has not moved and no resume attempt
  // has been reserved.
  //
  // A question that named no repository gets no reading and keeps the path it
  // has always had.
  const repositoryQuestion = await repositoryQuestionOfRow(row, (subjectKey) =>
    persistence.readWorkScope(subjectKey),
  );
  // WHAT THE READER IS HANDED IS WHAT THE PERSON WROTE, by the one rule the
  // record reads by (`answerAsWritten`): on the ticket the composed author line
  // comes off, and on the dashboard and MCP nothing does. Handed the line, the
  // model paraphrased "Filip Maszota: <reply>" back to Filip as a reply that
  // referenced Filip Maszota, and a display name like "Demo Team" points at a
  // repository nobody chose.
  //
  // `answer` itself stays as the channel delivered it, and it has to. The guard
  // below compares it with the next delivery of the same comments, the row
  // stores it, and the cron's retry hands the stored text back in as the
  // answer, where the record would strip it a second time and eat a person's
  // own "acme/api: " (A18).
  const theirWords = answerAsWritten(answer, { composedFromComments });
  // THESE EXACT WORDS, READ BEFORE, AND WE COULD NOT READ THEM. The Jira path
  // re-composes its answer out of the ticket's comments on every poll tick, so
  // without this the person would get the same sentence posted beside their
  // unchanged comments every few minutes until the question expired.
  const toldBefore =
    row.status === "pending" &&
    row.answer === answer &&
    row.answerReading?.outcome.kind === "unclear"
      ? row.answerReading
      : undefined;
  // BUT ONLY A MODEL'S VERDICT IS FINAL. A reading that says `deterministic`
  // means the provider could not be reached at all, and freezing that would
  // make one bad minute permanent: the words would never be read again, and the
  // person would be stuck re-typing an answer that was fine. So an unreachable
  // provider is retried on the next delivery and only the telling is
  // suppressed, while a model that read these exact words and could not settle
  // them is not asked twice about the same sentence.
  const answerReading =
    toldBefore?.readBy === "model"
      ? toldBefore
      : repositoryQuestion
        ? await readAnswerForRow(row, theirWords, repositoryQuestion, {
            isResumeRetry,
            ...(input.answerReadingDeps ? { deps: input.answerReadingDeps } : {}),
          })
        : undefined;
  arrival.reading = answerReading ?? null;
  // NOT CONFIDENT MEANS ASK, NOT GUESS. Nothing is recorded, the run is not
  // resumed, the question stays pending, and the person is told what we read
  // and what reply ends it. The run waits until they answer or the question
  // expires, which is the cost the owner accepted rather than resuming into a
  // decision nobody made.
  //
  // Not on a resume retry: those are the same words being delivered again, and
  // a delivery that already got past this gate must not be stopped by it on the
  // way back.
  if (answerReading?.outcome.kind === "unclear" && repositoryQuestion && !isResumeRetry) {
    const firstTelling = toldBefore === undefined;
    if (firstTelling) {
      logger.warn(
        { runId: row.runId, clarificationId: row.id, readBy: answerReading.readBy },
        "work_scope_answer_reading_unclear",
      );
    }
    // AND NO TRAIL ROW, DELIBERATELY, WHICH IS A LOSS AND IS WRITTEN DOWN HERE
    // RATHER THAN LEFT TO BE REDISCOVERED.
    //
    // Until this branch existed, an answer nobody could read reached the record
    // and wrote one `question_answered` row saying so. It no longer does,
    // because nothing here is answered: the row is still pending, the same
    // words may arrive again on the next poll tick, and a row per delivery
    // would be a history of our retries rather than of anybody's decisions.
    // Worse, `applyAnswerWorkScope` is idempotent per clarification id, so a
    // row written now would make the REAL answer to this question read as
    // already applied and drop it.
    //
    // WHAT IS LOST: somebody debugging "I answered three times and nothing
    // happened" has no record that the words arrived. Recovering it takes a
    // trail event of its own rather than the answered one, and that is a widening
    // of a closed set other readers switch on, over MCP. This delivery already
    // carries a migration and a contract change and is not taking a third.
    //
    // BACK TO THE BACKLOG, ON THE FIRST TELLING ONLY, and before the note so the
    // note says what actually happened. Where the ticket stands is known without
    // another read: the comment path only commits from the AI column and says
    // so with `skipTicketMove`, and every other path read the ticket above.
    //
    // NOT ON A LATER DELIVERY OF THE SAME WORDS, even with the ticket in AI
    // again, and that is deliberate. Somebody who moves the ticket first and
    // writes their new comment second would see it bounce back to the backlog
    // behind them, silently, because these words were already told; left in AI,
    // the next poll reads their new comment.
    const ticketInAiColumn =
      input.skipTicketMove === true ||
      (ticketStatus !== null &&
        ticketStatus.trim().toLowerCase() ===
          input.cancelSettings.COLUMN_AI.trim().toLowerCase());
    const waitsInBacklog =
      row.ticketKey && firstTelling && ticketInAiColumn
        ? await withdrawTicketWhileQuestionWaits({
            persistence,
            issueTracker,
            ticketKey: row.ticketKey,
            row,
            columns: input.cancelSettings,
          })
        : false;
    // Composed once, after the move, for both readers: the ticket and the
    // channel the answer came through carry the same words.
    const confirm = answerReadingConfirmMessage(
      answerReading,
      repositoryQuestion,
      waitsInBacklog
        ? {
            backlogColumnName: input.cancelSettings.COLUMN_BACKLOG,
            aiColumnName: input.cancelSettings.COLUMN_AI,
          }
        : undefined,
    );
    // To the ticket wherever there is one, exactly as the "recorded nothing"
    // sentence goes: the question was asked in public and the fact that it is
    // still open belongs beside it. The caller gets the same words back, so a
    // person answering from the dashboard or an MCP client is told in the
    // surface they used and never has to go and find the ticket.
    const posted =
      row.ticketKey && firstTelling
        ? await issueTracker
            .postComment(row.ticketKey, confirm)
            .then(() => true)
            .catch((error: unknown) => {
              logger.warn(
                { ticketKey: row.ticketKey, runId: row.runId, error: (error as Error).message },
                "work_scope_answer_reading_comment_failed",
              );
              return false;
            })
        : null;
    // TOLD MEANS TOLD, AND ONLY THEN IS IT WRITTEN DOWN.
    //
    // The reading used to be stored before the comment went out, so a Jira
    // comment that failed to post made every later tick read as "already told"
    // and a person who answers only in Jira was never told at all: the run sat
    // out its expiry in front of somebody who had answered it.
    //
    // Stored on every later pass, because the reading may have changed: the
    // same words read by the provider this time carry a different verdict than
    // the deterministic stand-in did last time, and the row must hold the
    // newest one. The write is a no-op against a row that is no longer
    // pending.
    if (posted !== false) {
      await persistence.recordUnreadable(row.id, answer, answerReading);
    }
    // What this delivery really told them: the ticket comment where it went
    // out, and the reply on the channels that have a screen behind them.
    arrival.note = posted === true || (posted === null && input.surface.kind !== "jira") ? confirm : null;
    return { kind: "answer_unclear", confirm };
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
    : await persistence.answer(row.id, answer, answerer, answerReading);
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
  if (authorship.kind === "write" && authorship.authorCount !== undefined) {
    // How many people really wrote these words, counted from the ticket rather
    // than believed from the delivery.
    arrival.authorCount = authorship.authorCount;
  }
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
  // The surface the caller stated, with the person behind an MCP client where
  // the deployment knows them: the ticket used to say every answer came "in
  // the dashboard", signed with an OAuth client id. An answer that arrived as
  // a comment on this very ticket gets no trace at all, whoever asked for one:
  // it would echo the person's own comment back at them.
  const commentSurface: ClarificationAnswerSurfaceComment | null =
    input.surface.kind === "mcp"
      ? { kind: "mcp", clientId: input.surface.clientId, person: mcpPerson }
      : input.surface.kind === "dashboard"
        ? { kind: "dashboard" }
        : null;
  if (row.ticketKey && !input.skipAnswerComment && !isResumeRetry && commentSurface) {
    const ticketKey = row.ticketKey;
    await issueTracker
      .postComment(
        ticketKey,
        formatClarificationAnswerComment({
          answeredByLabel: answerer.label,
          answer,
          surface: commentSurface,
        }),
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
  let recorded: RepositoryAnswerOutcome = {};
  if (authorship.kind === "write") {
    recorded = await recordRepositoryAnswer(persistence, {
      // THE ANSWERED ROW, not the pending one this call started with: it is the
      // row that carries `answerReading`, which is how the record reads the one
      // reading of these words instead of reading the text a second time. Every
      // other field the record uses is identical on both.
      row: answered,
      answer,
      answeredAt,
      answerer,
      composedFromComments,
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
  const tell = authorship.tell ?? recorded.told;
  // Composed once, for both readers. The ticket comment and the reply this call
  // returns carry the same words, so a person who reads both meets one story
  // about one answer, and a wording change lands on both at once.
  const notRecorded =
    tell === undefined
      ? undefined
      : formatAnswerNotRecordedComment(tell, {
          // How many repositories the question put in front of them, so a
          // question about one is answered in the singular.
          listedCount: new Set((row.askedRepositories ?? []).map((asked) => asked.repositoryKey)).size,
          // The second fact the sentence needs, and this row is the only place
          // that holds it: a question the run raised about a repository the
          // catalog does not enable or cannot serve offers a path route that
          // the next run cannot honour.
          aLaterRunCanPickThemUp: aLaterRunCanPickUpAskedRepositories(row.askedRepositories),
          // And the third: what may be said about writing a path in a
          // comment. Never that it works: whether the next run takes it is a
          // count of the ticket's open repositories, and this surface has no
          // run behind it to count them.
          commentPath: commentPathAfterAnUnrecordedAnswer({ questions: row.questions }),
        });
  // AND WHAT A DECLINE DECIDED, IN THE CHANNEL THAT TOOK IT. "none of these"
  // written as a ticket comment leaves every repository the question listed out
  // of this work for good, one permanent entry each in that person's name, and
  // the ticket said nothing about it: the sentence went back as the answer
  // call's reply, which on this path nobody ever sees, because the answer WAS a
  // comment and there is no screen behind it. The other two channels keep the
  // reply and get no ticket comment (C11s), so each person is told once, where
  // they answered. Not on a resume retry, which is the same answer arriving
  // again rather than a second decision.
  const declinedSentence =
    recorded.declined && recorded.declined.length > 0
      ? formatAnswerDeclinedComment(recorded.declined)
      : undefined;
  // AND WHAT AN ANSWER THAT NAMED SOMETHING LEFT OUT, which binds the same way
  // and told nobody. It goes back on the answer's own reply only: on the ticket
  // the run itself lists what it started without, keyed and with the way back
  // (C10, C11), and posting it here as well would tell one story twice in one
  // thread.
  const leftOutSentence =
    recorded.leftOut && recorded.leftOut.length > 0
      ? formatAnswerLeftOutComment(recorded.leftOut)
      : undefined;
  // AND WHAT THE WORKFLOW CHOSE WHEN IT WAS ASKED TO. Said in the same place a
  // decline is and for the same reason: on the ticket the answer WAS a comment
  // and there is no screen behind it, and on the other two channels the reply is
  // where the person is looking. The record and the trail say it as well, so
  // the dashboard and MCP can explain the choice later without this sentence.
  const delegatedSentence = recorded.delegated
    ? formatAnswerDelegatedComment({
        taken: recorded.delegated.taken,
        notTaken: recorded.delegated.notTaken,
        notEnabled: recorded.delegated.notEnabled,
        commentPath: commentPathAfterAnUnrecordedAnswer({ questions: row.questions }),
      })
    : undefined;
  // AND WHAT THEY NAMED THAT THIS QUESTION NEVER OFFERED, which until now went
  // nowhere at all. The keys the question put in front of somebody are the only
  // ones that become a decision, so "api and web" to a question about api
  // records api and nothing else; saying nothing about web is the system
  // quietly doing half the job, and they find out from a pull request that is
  // missing the other half.
  //
  // JOINED TO THE OTHER SENTENCES RATHER THAN RANKED AGAINST THEM. It is not an
  // alternative to "your answer recorded nothing": both can be true of one
  // reply, and this is the one nothing else on this path can say.
  //
  // AND, WHERE THE ANSWER CHOSE OR REFUSED WHAT IT WAS OFFERED, WHAT BECAME OF
  // EACH NAME ONCE IT WAS LOOKED UP: taken, recorded but not enabled, or matched
  // to nothing. Where the answer did neither (a delegation beside a name, or an
  // answer we declined to attribute) the name was not acted on at all, and the
  // sentence that says so is the one this path has always used.
  const notOfferedSentence = recorded.alsoNamed
    ? formatAnswerAlsoNamedComment(recorded.alsoNamed)
    : answerReading?.unofferedNames && answerReading.unofferedNames.length > 0 && repositoryQuestion
      ? formatAnswerNotOfferedComment({
          names: answerReading.unofferedNames,
          askedKeys: repositoryQuestion.askedKeys,
        })
      : undefined;
  const toTheTicket = [
    notRecorded ??
      (composedFromComments && !isResumeRetry ? (declinedSentence ?? delegatedSentence) : undefined),
    // On the ticket too, and on a comment answer especially: that channel has no
    // screen behind it, so a reply nobody reads is the same as saying nothing.
    isResumeRetry ? undefined : notOfferedSentence,
  ]
    .filter((sentence): sentence is string => sentence !== undefined)
    .join("\n\n");
  let postedToTheTicket = false;
  if (toTheTicket.length > 0 && row.ticketKey) {
    const ticketKey = row.ticketKey;
    postedToTheTicket = await issueTracker
      .postComment(ticketKey, toTheTicket)
      .then(() => true)
      .catch((error: unknown) => {
        logger.warn(
          { ticketKey, runId: row.runId, error: (error as Error).message },
          "work_scope_answer_not_counted_comment_failed",
        );
        return false;
      });
  }

  try {
    await resumeHook(answered.hookToken, {
      answer,
      answeredById: answerer.id,
      answeredByLabel: answerer.label,
      answeredAt: answeredAt.toISOString(),
      // THE READING TRAVELS WITH THE WORDS. The resumed run used to read the
      // sentence for itself and reach a different conclusion than the record
      // had already written, which is how a person's "yes" became a selection
      // nobody acted on. Sending it here means the run consumes the one reading
      // rather than a second reader's opinion of the same text, and a replay
      // gets it out of the journal rather than by calling anything.
      ...(answerReading ? { answerReading } : {}),
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

  // WHAT THIS ANSWER DID TO THE RECORD, in one field and one wording for every
  // channel that took it. Either it recorded nothing and this says why, in the
  // words the ticket comment carries, or it declined the repositories the
  // question listed and this says which. Absent when the answer recorded what
  // it named, which is the case that needs no sentence.
  const recordOutcome = [
    notRecorded ?? declinedSentence ?? delegatedSentence ?? leftOutSentence,
    notOfferedSentence,
  ]
    .filter((sentence): sentence is string => sentence !== undefined)
    .join("\n\n");
  // What this delivery told the person who made it: the ticket comment for an
  // answer that arrived as one, the reply for a channel with a screen behind
  // it. A comment that failed to post claims nothing.
  arrival.note =
    input.surface.kind === "jira"
      ? postedToTheTicket
        ? toTheTicket
        : null
      : recordOutcome.length > 0
        ? recordOutcome
        : null;
  return { kind: "answered", row: answered, ...(recordOutcome ? { recordOutcome } : {}) };
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
