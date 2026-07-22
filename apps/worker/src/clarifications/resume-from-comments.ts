import { env } from "../../env.js";
import {
  IssueTrackerNotFoundError,
  type IssueTrackerAdapter,
} from "../adapters/issue-tracker/types.js";
import type { Db } from "../db/client.js";
import { ticketPageUrl } from "../lib/dashboard-links.js";
import { logger } from "../lib/logger.js";
import {
  answerClarificationAndResume,
  MAX_ANSWER_LENGTH,
  retireClarificationForGoneTicket,
} from "./answer-core.js";
import {
  CLARIFICATION_NUDGE_MARKER,
  formatAlreadyAnsweredComment,
  formatClarificationNudgeComment,
} from "./comment-format.js";
import { getHookClarification, getResumableClarificationForTicket } from "./hook-store.js";

export type CommentResumeStatus =
  | "no_clarification" // caller proceeds to dispatchTicket as today
  | "resumed"
  | "resume_retry_pending" // CAS committed but resume failed retryably; cron heals next tick
  | "no_answer_comments" // nudged or not; do not dispatch
  | "already_answered" // lost the CAS race to another channel
  | "ticket_gone"
  | "not_in_ai_column"; // live ticket is not in AI; caller falls through to dispatch

/**
 * Wake a suspended clarification run when a human answers by commenting on the
 * Jira ticket and moving it back into the AI column. Comments alone never
 * resume; the move is the commit gesture, so this only ever commits while the
 * ticket is live in the AI column. Composes the human comments into the answer
 * and rides answer-core's CAS + retry semantics; it never moves tickets,
 * mutates labels, or touches active_runs (the resumed run owns all of that).
 */
export async function resumeClarificationFromComments(input: {
  db: Db;
  issueTracker: IssueTrackerAdapter;
  ticketKey: string;
  allowNudge: boolean;
}): Promise<{ status: CommentResumeStatus; runId?: string; nudged?: boolean }> {
  const { db, issueTracker, ticketKey, allowNudge } = input;

  const row = await getResumableClarificationForTicket(db, ticketKey);
  if (!row) return { status: "no_clarification" };

  // An already-answered row is a dashboard answer whose resume was lost (e.g. a
  // 503 that never retried). Retry it with the stored answer via the core's
  // isResumeRetry path (a consumed hook is treated as won, idempotent). Never
  // compose from comments here so identical retries stay convergent.
  if (row.status === "answered") {
    const outcome = await answerClarificationAndResume({
      db,
      row,
      rawAnswer: row.answer ?? "",
      actor: {
        id: row.answeredById ?? "system",
        label: row.answeredByLabel ?? "system",
      },
      issueTracker,
      skipTicketFetch: false,
    });
    switch (outcome.kind) {
      case "answered":
        return { status: "resumed", runId: row.runId };
      case "resume_failed_retryable":
        logger.warn(
          { ticketKey, runId: row.runId },
          "clarification_resume_retry_pending",
        );
        return { status: "resume_retry_pending", runId: row.runId };
      case "ticket_gone":
        return { status: "ticket_gone" };
      case "conflict":
        return { status: "already_answered" };
      case "invalid_answer":
        // Defensive: an answered row with an empty answer cannot resume. Do not
        // throw; the run stays parked and expiry eventually reclaims it.
        logger.warn(
          { ticketKey, runId: row.runId },
          "clarification_resume_answered_row_empty_answer",
        );
        return { status: "already_answered" };
    }
  }

  let ticket;
  try {
    ticket = await issueTracker.fetchTicket(ticketKey);
  } catch (err) {
    if (err instanceof IssueTrackerNotFoundError) {
      await retireClarificationForGoneTicket(db, row);
      return { status: "ticket_gone" };
    }
    throw err;
  }

  // Resume is the human's commit gesture: only ever act while the ticket is
  // live in the AI column. Guards the cron's stale JQL snapshot and
  // status-less webhook payloads from committing an answer prematurely.
  if (
    ticket.trackerStatus.trim().toLowerCase() !== env.COLUMN_AI.trim().toLowerCase()
  ) {
    return { status: "not_in_ai_column" };
  }

  // Fail closed on unknowable bot identity: without it we cannot tell our own
  // questions/nudge comments from a human answer, so treat comments as zero and
  // skip nudging (the nudge-dedup scan also needs to spot bot comments).
  let botAccountId = "";
  let botIdentityAvailable = false;
  try {
    const id = (await issueTracker.getCurrentUserAccountId?.())?.trim() ?? "";
    if (id) {
      botAccountId = id;
      botIdentityAvailable = true;
    }
  } catch {
    // Fall through: identity unavailable.
  }
  if (!botIdentityAvailable) {
    logger.warn({ ticketKey }, "clarification_resume_bot_identity_unavailable");
  }

  const askedAtMs = row.askedAt.getTime();
  const qualifying = botIdentityAvailable
    ? ticket.comments.filter(
        (c) =>
          // Comments without an accountId cannot be proven non-bot.
          c.accountId &&
          c.accountId !== botAccountId &&
          Date.parse(c.createdAt) > askedAtMs,
      )
    : [];

  const noAnswer = async (): Promise<{
    status: CommentResumeStatus;
    nudged: boolean;
  }> => {
    let nudged = false;
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
            formatClarificationNudgeComment({
              dashboardUrl: ticketPageUrl(env.DASHBOARD_ORIGIN, ticketKey),
              aiColumnName: env.COLUMN_AI,
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

  if (qualifying.length === 0) return noAnswer();

  const composed = qualifying
    .map((c) => `${c.author}: ${c.body.trim()}`)
    .join("\n\n")
    .trim()
    .slice(0, MAX_ANSWER_LENGTH);
  if (!composed) return noAnswer();

  // Attribute to the LAST commenter: their comment completed the answer and the
  // choice is stable across identical retries. The label lists every unique
  // author in first-appearance order.
  const lastCommenter = qualifying[qualifying.length - 1];
  const answeredById = `jira:${lastCommenter.accountId}`;
  const uniqueAuthors: string[] = [];
  for (const c of qualifying) {
    if (!uniqueAuthors.includes(c.author)) uniqueAuthors.push(c.author);
  }
  const answeredByLabel = `${uniqueAuthors.join(", ")} (via Jira)`;

  const outcome = await answerClarificationAndResume({
    db,
    row,
    rawAnswer: composed,
    actor: { id: answeredById, label: answeredByLabel },
    issueTracker,
    skipTicketFetch: true,
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
    case "conflict": {
      // Another channel won. Acknowledge in Jira only when the winner is NOT a
      // Jira comment answer; suppress noise on duplicate webhook deliveries
      // where the winner IS our own jira:* answer.
      const winner = await getHookClarification(db, row.id);
      if (!(winner?.answeredById ?? "").startsWith("jira:")) {
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
    case "ticket_gone":
      return { status: "ticket_gone" };
    case "invalid_answer":
      // Unreachable after the empty-compose guard above; defensive only.
      logger.warn(
        { ticketKey, runId: row.runId },
        "clarification_resume_unexpected_invalid_answer",
      );
      return { status: "no_answer_comments", nudged: false };
  }
}
