// Static import so route tests can vi.mock("workflow/api"): a dynamic import
// would bypass the module mock and hit the real Workflow runtime.
import { getHookByToken, resumeHook } from "workflow/api";
import type { Db } from "../db/client.js";
import {
  IssueTrackerNotFoundError,
  type IssueTrackerAdapter,
} from "../adapters/issue-tracker/types.js";
import { resolveAwaitingRun } from "../lib/telemetry/run-telemetry.js";
import { answerHookClarification, type HookClarificationRow } from "./hook-store.js";
import { supersedeClarification, supersedePendingForTicket } from "./store.js";

export const MAX_ANSWER_LENGTH = 10_000;

export type AnswerClarificationOutcome =
  | { kind: "answered"; row: HookClarificationRow }
  | { kind: "invalid_answer" }
  | { kind: "conflict" }
  | { kind: "ticket_gone" }
  | { kind: "resume_failed_retryable"; error: unknown };

/**
 * Answer a pending clarification and resume its asking run, with the CAS and
 * retry semantics shared by every caller (dashboard and, later, Jira webhook).
 * Returns a tagged outcome instead of throwing HTTP errors so the transport
 * layer owns status-code mapping; the ticket fetch is injected so this module
 * stays free of adapter-construction and HTTP concerns.
 */
export async function answerClarificationAndResume(input: {
  db: Db;
  row: HookClarificationRow;
  rawAnswer: string;
  actor: { id: string; label: string };
  issueTracker: Pick<IssueTrackerAdapter, "fetchTicket">;
  skipTicketFetch?: boolean;
}): Promise<AnswerClarificationOutcome> {
  const { db, row, rawAnswer, actor, issueTracker } = input;

  const answer = rawAnswer.trim();
  if (!answer || answer.length > MAX_ANSWER_LENGTH) {
    return { kind: "invalid_answer" };
  }

  const isResumeRetry = row.status === "answered" && row.answer === answer;
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
      await retireClarificationForGoneTicket(db, row);
      return { kind: "ticket_gone" };
    }
  }

  const answered = isResumeRetry
    ? row
    : await answerHookClarification(db, row.id, answer, answerer);
  if (!answered) {
    return { kind: "conflict" };
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
    // same answer can be retried. A missing hook means the resume won but the
    // HTTP response was lost (or another identical retry already won).
    const hookStillExists = await getHookByToken(answered.hookToken)
      .then(() => true)
      .catch(() => false);
    if (hookStillExists) {
      return { kind: "resume_failed_retryable", error };
    }
  }

  return { kind: "answered", row: answered };
}

/**
 * Best-effort teardown when a clarification's Jira ticket has been deleted:
 * supersede sibling questions, supersede this row, and resolve the awaiting run
 * so it does not stay parked forever. Each step swallows its own error.
 */
export async function retireClarificationForGoneTicket(
  db: Db,
  row: HookClarificationRow,
): Promise<void> {
  if (row.ticketKey) {
    await supersedePendingForTicket(db, row.ticketKey).catch(() => {});
  }
  await supersedeClarification(db, row.id).catch(() => {});
  await resolveAwaitingRun(db, row.runId).catch(() => {});
}
