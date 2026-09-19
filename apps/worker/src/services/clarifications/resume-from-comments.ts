import { env } from "../../infra/vcs-config.js";
import {
  IssueTrackerNotFoundError,
  type IssueTrackerAdapter,
  type TicketComment,
} from "../../adapters/issue-tracker/types.js";
import type { Db } from "../../db/types.js";
import type { SettingsSnapshot } from "@shared/contracts";
import type { AnswerReadingDeps } from "../work-scope/index.js";
import { ticketPageUrl } from "../../engine/support/dashboard-links.js";
import { logger } from "../../infra/logger.js";
import {
  answerClarificationAndResume,
  answerConnectedClarificationAndResume,
  MAX_ANSWER_LENGTH,
} from "./answer-core.js";
import { retireClarificationForGoneTicket } from "./retirement.js";
import { retireConnectedClarificationForGoneTicket } from "../../db/repositories/clarifications.js";
import {
  commentsCoverAnswerWindow,
  composedAnswerActorId,
  composedAuthorCount,
  isComposedAnswerActor,
  qualifyingComments,
  readBotAccountId,
} from "./answer-authorship.js";
import {
  CLARIFICATION_NUDGE_MARKER,
  formatAlreadyAnsweredComment,
  formatClarificationNudgeComment,
  formatClarificationUnreadableNudgeComment,
} from "./comment-format.js";
import { getHookClarification, getResumableClarificationForTicket } from "../../db/repositories/clarification-hooks.js";
import {
  claimAnsweredClarificationResume,
  claimConnectedAnsweredClarificationResume,
  finishAnsweredClarificationResumeClaim,
  finishConnectedAnsweredClarificationResumeClaim,
  getConnectedHookClarification,
  getConnectedResumableClarificationForTicket,
} from "../../db/repositories/clarification-hooks.js";

export type CommentResumeStatus =
  | "no_clarification" // caller proceeds to dispatchTicket as today
  | "resumed"
  | "resume_retry_pending" // CAS committed but resume failed retryably; cron heals next tick
  // Answer stored, delivery budget spent; the run is settled and the human told.
  | "resume_exhausted"
  // The answer could not be read, so nothing was recorded and nothing resumed.
  // The question is still pending and the person has been told on the ticket
  // what we read and what reply ends it. Never dispatch: the run is parked on
  // this very question and a new run would ask it again.
  | "answer_unclear"
  | "no_answer_comments" // nudged or not; do not dispatch
  | "already_answered" // lost the CAS race to another channel
  | "ticket_gone"
  | "not_in_ai_column"; // live ticket is not in AI; caller falls through to dispatch

/**
 * Wake a suspended clarification run when a human answers by commenting on the
 * Jira ticket and moving it back into the AI column. Comments alone never
 * resume; the move is the commit gesture, so this only ever commits while the
 * ticket is live in the AI column. Composes the human comments into the answer
 * and rides answer-core's CAS + retry semantics; it never mutates labels or
 * touches active_runs (the resumed run owns that). The human already performed
 * the column move on this path, so the comment-composed answer opts out of
 * answer-core's own transition; the answered-retry branch keeps it, which is
 * what re-syncs a dashboard answer whose column move never landed.
 */
export async function resumeClarificationFromComments(input: {
  db?: Db;
  issueTracker: IssueTrackerAdapter;
  ticketKey: string;
  allowNudge: boolean;
  aiColumn: string;
  cancelSettings: Pick<SettingsSnapshot, "COLUMN_AI" | "COLUMN_BACKLOG">;
  /** The model that reads a repository answer, handed down so a test can drive
   *  the reading without a provider. Production passes nothing and the core
   *  uses the small default model. */
  answerReadingDeps?: AnswerReadingDeps;
}): Promise<{ status: CommentResumeStatus; runId?: string; nudged?: boolean }> {
  const { db, issueTracker, ticketKey, allowNudge, aiColumn } = input;
  const persistence: {
    getResumable: (key: string) => ReturnType<typeof getResumableClarificationForTicket>;
    claim: (row: { runId: string; subjectKey: string | null; ticketKey: string | null }) => Promise<"claimed" | "in_progress" | "resumed" | "settled">;
    finish: (runId: string, status: "awaiting" | "running" | "blocked") => Promise<void>;
    /** Typed against the core it calls, both halves of it. This is the one call
     *  that decides what a person's answer means, so a field the core reads and
     *  this path spells differently has to be a compile error here. */
    answer: (
      value: Parameters<typeof answerConnectedClarificationAndResume>[0],
    ) => ReturnType<typeof answerConnectedClarificationAndResume>;
    retire: (row: Parameters<typeof retireClarificationForGoneTicket>[1]) => Promise<void>;
    getHook: (id: string) => ReturnType<typeof getHookClarification>;
  } = db ? {
    getResumable: (key: string) => getResumableClarificationForTicket(db, key),
    claim: (row: { runId: string; subjectKey: string | null; ticketKey: string | null }) => claimAnsweredClarificationResume(db, row),
    finish: (runId: string, status: "awaiting" | "running" | "blocked") => finishAnsweredClarificationResumeClaim(db, { runId, status }),
    answer: (value: Parameters<typeof answerConnectedClarificationAndResume>[0]) =>
      answerClarificationAndResume({ ...value, db }),
    retire: (row: Parameters<typeof retireClarificationForGoneTicket>[1]) => retireClarificationForGoneTicket(db, row),
    getHook: (id: string) => getHookClarification(db, id),
  } : {
    getResumable: getConnectedResumableClarificationForTicket,
    claim: claimConnectedAnsweredClarificationResume,
    finish: (runId: string, status: "awaiting" | "running" | "blocked") => finishConnectedAnsweredClarificationResumeClaim({ runId, status }),
    answer: answerConnectedClarificationAndResume,
    retire: retireConnectedClarificationForGoneTicket,
    getHook: getConnectedHookClarification,
  };

  const row = await persistence.getResumable(ticketKey);
  if (!row) return { status: "no_clarification" };

  // An already-answered row is a dashboard answer whose resume was lost (e.g. a
  // 503 that never retried). Retry it with the stored answer via the core's
  // isResumeRetry path (a consumed hook is treated as won, idempotent). Never
  // compose from comments here so identical retries stay convergent.
  if (row.status === "answered") {
    // Jira can deliver the comment and the status move as separate webhooks.
    // Once the first delivery has cleared the live park marker, the second
    // must not call resumeHook again: it is a duplicate delivery, not a lost
    // resume. Keep the dashboard's retry behavior in answer-core unchanged by
    // using the Jira run marker only on this provider-specific path. A row that
    // is still awaiting input means the earlier resume needs a retry.
    const claim = await persistence.claim(row);
    if (claim === "resumed") {
      return { status: "resumed", runId: row.runId };
    }
    if (claim === "in_progress") {
      return { status: "resume_retry_pending", runId: row.runId };
    }
    if (claim === "settled") {
      return { status: "already_answered", runId: row.runId };
    }

    // No count is passed: this delivery composed nothing. The record counts the
    // authors of a stored answer again from the ticket, out of the read it makes
    // anyway, and does that for every channel redelivering one rather than for
    // this one alone.
    let outcome;
    try {
      outcome = await persistence.answer({
        row,
        rawAnswer: row.answer ?? "",
        actor: {
          id: row.answeredById ?? "system",
          label: row.answeredByLabel ?? "system",
        },
        // The channel this redelivery came through. It records no delivery of
        // its own (the core writes one per arrival, and this is our retry of
        // words already recorded) and posts no answer comment.
        surface: { kind: "jira" },
        issueTracker,
        skipTicketFetch: false,
        ...(input.answerReadingDeps ? { answerReadingDeps: input.answerReadingDeps } : {}),
        aiColumn,
        cancelSettings: input.cancelSettings,
      });
    } catch (error) {
      await persistence.finish(row.runId, "awaiting");
      throw error;
    }
    switch (outcome.kind) {
      case "answered": {
        await persistence.finish(row.runId, "running");
        return { status: "resumed", runId: row.runId };
      }
      case "resume_failed_retryable": {
        await persistence.finish(row.runId, "awaiting");
        logger.warn(
          { ticketKey, runId: row.runId },
          "clarification_resume_retry_pending",
        );
        return { status: "resume_retry_pending", runId: row.runId };
      }
      case "resume_exhausted": {
        // The core settled the run and retired the question, so the resuming
        // marker is already gone and handing it back as awaiting would invite
        // the next tick to retry a clarification nothing can deliver.
        return { status: "resume_exhausted", runId: row.runId };
      }
      case "ticket_gone": {
        await persistence.finish(row.runId, "blocked");
        return { status: "ticket_gone" };
      }
      case "ticket_transition_failed": {
        // Nothing was committed, so release the claim and let the next delivery
        // (or the cron) retry the whole resume, transition included.
        await persistence.finish(row.runId, "awaiting");
        logger.warn(
          { ticketKey, runId: row.runId },
          "clarification_resume_transition_retry_pending",
        );
        return { status: "resume_retry_pending", runId: row.runId };
      }
      case "conflict": {
        await persistence.finish(row.runId, "awaiting");
        return { status: "already_answered" };
      }
      case "resume_terminal":
        return { status: "already_answered", runId: row.runId };
      case "answer_unclear": {
        // Unreachable: this branch re-delivers an answer that already passed the
        // reading gate, and the core does not put a retry through it a second
        // time. Defensive only, and it releases the claim exactly as the other
        // nothing-committed outcomes do.
        await persistence.finish(row.runId, "awaiting");
        return { status: "answer_unclear", runId: row.runId };
      }
      case "invalid_answer": {
        await persistence.finish(row.runId, "awaiting");
        // Defensive: an answered row with an empty answer cannot resume. Do not
        // throw; the run stays parked and expiry eventually reclaims it.
        logger.warn(
          { ticketKey, runId: row.runId },
          "clarification_resume_answered_row_empty_answer",
        );
        return { status: "already_answered" };
      }
    }
  }

  let ticket;
  try {
    // With the window, because this read is the one that decides whether a
    // question was answered and by how many people. Every OTHER ticket read in
    // the deployment asks for no window and costs one request; this one pays
    // for the pages, and only back as far as the question.
    ticket = await issueTracker.fetchTicket(ticketKey, {
      commentsSince: row.askedAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof IssueTrackerNotFoundError) {
      await persistence.retire(row);
      return { status: "ticket_gone" };
    }
    throw err;
  }

  // Resume is the human's commit gesture: only ever act while the ticket is
  // live in the AI column. Guards the cron's stale JQL snapshot and
  // status-less webhook payloads from committing an answer prematurely.
  if (
    ticket.trackerStatus.trim().toLowerCase() !== aiColumn.trim().toLowerCase()
  ) {
    return { status: "not_in_ai_column" };
  }

  // Fail closed on unknowable bot identity: without it we cannot tell our own
  // questions/nudge comments from a human answer, so treat comments as zero and
  // skip nudging (the nudge-dedup scan also needs to spot bot comments).
  const botAccountId = await readBotAccountId(issueTracker, ticketKey);
  const botIdentityAvailable = botAccountId !== null;

  const askedAtMs = row.askedAt.getTime();
  const qualifying =
    botAccountId !== null
      ? qualifyingComments(ticket.comments, botAccountId, { afterMs: askedAtMs })
      : [];

  // Does that read hold every comment written since the question? Everything
  // below turns on it, because everything below reads an ABSENCE: nobody
  // answered, or nobody has been nudged yet. A read with a gap in that window
  // establishes neither, and acting on it nudges a person about the answer they
  // just wrote and composes an answer out of the half of a conversation we
  // happened to read.
  //
  // The window, not the whole ticket. A ticket too long to read in one go is
  // read from its newest end, so it can still hold every comment since the
  // question, and refusing those tickets outright would be an outage we
  // inflicted on ourselves.
  const commentsCoverWindow = commentsCoverAnswerWindow(ticket, askedAtMs);

  const noAnswer = async (): Promise<{
    status: CommentResumeStatus;
    nudged: boolean;
  }> => {
    let nudged = false;
    // A read we cannot vouch for still gets a nudge, with a different sentence.
    // Saying nothing is the one response that cannot be right: the run is
    // waiting, nobody can see why, and a person who did answer learns only that
    // the system ignored them. The cost of nudging on an unprovable read is a
    // second nudge on a ticket whose first one we could not see, which is a
    // duplicate comment; the cost of silence is a run that waits out its expiry
    // in front of somebody who answered it.
    if (allowNudge && botIdentityAvailable) {
      const alreadyNudged = ticket.comments.some(
        (c) =>
          c.accountId === botAccountId &&
          Date.parse(c.createdAt) > askedAtMs &&
          c.body.includes(CLARIFICATION_NUDGE_MARKER),
      );
      if (!alreadyNudged) {
        try {
          await issueTracker.postComment(
            ticketKey,
            commentsCoverWindow
              ? formatClarificationNudgeComment({
                  dashboardUrl: ticketPageUrl(env.DASHBOARD_ORIGIN, ticketKey),
                  aiColumnName: aiColumn,
                })
              : formatClarificationUnreadableNudgeComment({
                  dashboardUrl: ticketPageUrl(env.DASHBOARD_ORIGIN, ticketKey),
                  aiColumnName: aiColumn,
                }),
          );
          nudged = true;
        } catch (error) {
          logger.warn(
            { ticketKey, error: (error as Error).message },
            "clarification_resume_nudge_failed",
          );
        }
      }
    }
    return { status: "no_answer_comments", nudged };
  };

  // Nothing is composed out of a read with a gap where the answer should be.
  // What we did read may hold one person's words while a second person's are on
  // a page nobody fetched, and an answer composed from half a conversation is
  // recorded as that one person's decision: a fabricated decision, from words
  // nobody can be credited with. Reading again later is what fixes it, and the
  // question stays pending until then, which the clarification expiry already
  // bounds.
  //
  // THE LIMIT, SAID OUT LOUD: this is a gap in the window, not a long ticket. A
  // ticket with more comments than one read may page through is read from its
  // newest end and still answers here. What cannot be answered through comments
  // is a ticket that grew by more comments than that bound SINCE THE QUESTION
  // WAS ASKED, and a provider that claims comments it will not hand over. The
  // dashboard and MCP still answer both; the alternative is deciding a person's
  // repositories from a list that is missing comments by construction.
  if (!commentsCoverWindow) {
    logger.warn({ ticketKey, runId: row.runId }, "clarification_resume_comment_window_incomplete");
    return noAnswer();
  }

  if (qualifying.length === 0) return noAnswer();

  // Composed and counted from the SAME comments, which is why the cap is applied
  // per comment rather than to the joined text. Cutting the join mid-sentence
  // leaves an answer whose words are one person's and whose count is three
  // people's: it is then declined for words it does not contain, and attributed
  // to whoever's text the cut landed in. A whole comment or none of it.
  const included: TicketComment[] = [];
  let composed = "";
  for (const c of qualifying) {
    const piece = `${c.author}: ${c.body.trim()}`;
    const next = composed ? `${composed}\n\n${piece}` : piece;
    if (next.length > MAX_ANSWER_LENGTH) break;
    composed = next;
    included.push(c);
  }
  if (included.length === 0) {
    // One comment longer than the whole cap, so there is no whole comment to
    // take. Their words, cut where the cap falls, and one author either way.
    const first = qualifying[0]!;
    composed = `${first.author}: ${first.body.trim()}`.slice(0, MAX_ANSWER_LENGTH);
    included.push(first);
  }
  composed = composed.trim();
  if (!composed) return noAnswer();

  // Attribute to the LAST commenter: their comment completed the answer and the
  // choice is stable across identical retries. It is the last INCLUDED comment,
  // which is also where the answer's window closes when the record counts its
  // authors again later (`composedAnswerEvidence`). The label lists every unique
  // author in first-appearance order.
  const lastCommenter = included.at(-1)!;
  // Built through the helper that the record's guard reads back, so the mark of
  // a composed answer cannot drift between the two.
  const answeredById = composedAnswerActorId(lastCommenter.accountId ?? "");
  const uniqueAuthors: string[] = [];
  for (const c of included) {
    if (!uniqueAuthors.includes(c.author)) uniqueAuthors.push(c.author);
  }
  // Cap the label: many distinct commenters would otherwise store an unbounded
  // string in answered_by_label and inject it into prompts/memory.
  const answeredByLabel = `${uniqueAuthors.join(", ")} (via Jira)`.slice(0, 200);

  const outcome = await persistence.answer({
    row,
    rawAnswer: composed,
    actor: { id: answeredById, label: answeredByLabel },
    surface: { kind: "jira" },
    issueTracker,
    skipTicketFetch: true,
    // How many people these words came from, told to the record as a number
    // because this is the only place that knows it: once composed, nothing
    // downstream can tell one person's answer from three people's chatter, and
    // the record refuses to decide anything from the latter. Of the comments
    // that are IN the answer, never of the ones that were merely read.
    answerAuthorCount: composedAuthorCount(included),
    // The answer is literally a comment on this ticket already, so mirroring it
    // back would echo the human's own words at them.
    skipAnswerComment: true,
    // The guard above already proved the ticket is live in the AI column, so the
    // core's transition could only be a no-op costing one more provider read.
    skipTicketMove: true,
    ...(input.answerReadingDeps ? { answerReadingDeps: input.answerReadingDeps } : {}),
    aiColumn,
    cancelSettings: input.cancelSettings,
  });
  switch (outcome.kind) {
    case "answered":
      return { status: "resumed", runId: row.runId };
    case "resume_failed_retryable":
      // The CAS committed; the cron heals via the answered-retry path next tick.
      logger.warn(
        { ticketKey, runId: row.runId },
        "clarification_resume_retry_pending",
      );
      return { status: "resume_retry_pending", runId: row.runId };
    case "resume_exhausted":
      // Unreachable: this path answers a pending row, and a fresh answer starts
      // from a full delivery budget. Defensive only.
      return { status: "resume_exhausted", runId: row.runId };
    case "conflict": {
      // Another channel won. Acknowledge in Jira only when the winner is NOT a
      // Jira comment answer; suppress noise on duplicate webhook deliveries
      // where the winner IS our own jira:* answer.
      const winner = await persistence.getHook(row.id);
      // A row we cannot read back is not somebody else's answer. Posting then
      // tells the ticket "answered by someone" on the strength of nothing, in
      // the one case where the winner may well be this very answer arriving
      // twice, which is the noise this check exists to keep off the ticket.
      if (winner && !isComposedAnswerActor(winner.answeredById)) {
        await issueTracker
          .postComment(
            ticketKey,
            formatAlreadyAnsweredComment({
              answeredByLabel: winner?.answeredByLabel ?? "someone",
            }),
          )
          .catch((error) =>
            logger.warn(
              { ticketKey, error: (error as Error).message },
              "clarification_resume_already_answered_comment_failed",
            ),
          );
      }
      return { status: "already_answered" };
    }
    case "resume_terminal":
      return { status: "already_answered", runId: row.runId };
    case "answer_unclear":
      // The core already said so on the ticket, in the channel this answer came
      // from. Nothing was committed, so there is no claim to settle differently
      // and nothing for the caller to dispatch: the run is still parked on this
      // question and the next comment is read against it.
      logger.info(
        { ticketKey, runId: row.runId },
        "clarification_answer_unclear",
      );
      return { status: "answer_unclear", runId: row.runId };
    case "ticket_gone":
      return { status: "ticket_gone" };
    case "ticket_transition_failed":
      // Unreachable: this path skips the transition entirely. Defensive only.
      logger.warn(
        { ticketKey, runId: row.runId },
        "clarification_resume_transition_retry_pending",
      );
      return { status: "resume_retry_pending", runId: row.runId };
    case "invalid_answer":
      // Unreachable after the empty-compose guard above; defensive only.
      logger.warn(
        { ticketKey, runId: row.runId },
        "clarification_resume_unexpected_invalid_answer",
      );
      return { status: "no_answer_comments", nudged: false };
  }
}

export function resumeConnectedClarificationFromComments(
  input: Omit<Parameters<typeof resumeClarificationFromComments>[0], "db">,
) {
  return resumeClarificationFromComments(input);
}
