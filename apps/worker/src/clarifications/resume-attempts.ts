import { and, eq, lt, sql } from "drizzle-orm";
import type { ClarificationStatus } from "@shared/contracts";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";
import { PostgresRunRegistry } from "../adapters/run-registry/postgres.js";
import type { Db } from "../db/client.js";
import { clarificationRequests } from "../db/schema.js";
import { cancelRunForOperator } from "../lib/cancel-run.js";
import { logger } from "../lib/logger.js";
import { formatClarificationResumeFailedComment } from "./comment-format.js";

/** The answering call and two scheduled recovery deliveries. */
const MAX_RESUME_ATTEMPTS = 3;

/** Final state for an answer that could not be delivered within the budget. */
export const RESUME_FAILED_STATUS: ClarificationStatus = "resume_failed";

/** Leading words of the run failure reason written when the budget is spent. */
const CLARIFICATION_RESUME_FAILURE_REASON_PREFIX = "Clarification resume failed:";

const MAX_RESUME_ERROR_LENGTH = 500;

export interface ResumeAttemptSubject {
  id: string;
  runId: string;
  ticketKey: string | null;
  subjectKey: string;
}

export interface ResumeAttemptReservation {
  attempt: number;
  answeredAt: Date;
}

/** Reserve one delivery before touching the Workflow hook. */
export async function reserveResumeAttempt(
  db: Db,
  id: string,
  answeredAt: Date,
): Promise<ResumeAttemptReservation | null> {
  const [row] = await db
    .update(clarificationRequests)
    .set({
      resumeAttempts: sql`coalesce(${clarificationRequests.resumeAttempts}, 0) + 1`,
    })
    .where(
      and(
        eq(clarificationRequests.id, id),
        eq(clarificationRequests.status, "answered"),
        eq(clarificationRequests.answeredAt, answeredAt),
        lt(sql`coalesce(${clarificationRequests.resumeAttempts}, 0)`, MAX_RESUME_ATTEMPTS),
      ),
    )
    .returning({ resumeAttempts: clarificationRequests.resumeAttempts });
  return row?.resumeAttempts === undefined || row.resumeAttempts === null
    ? null
    : { attempt: row.resumeAttempts, answeredAt };
}

function resumeErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, MAX_RESUME_ERROR_LENGTH);
}

function failureReason(row: ResumeAttemptSubject, message: string): string {
  return `${CLARIFICATION_RESUME_FAILURE_REASON_PREFIX} the answer to clarification ${row.id} was recorded but run ${row.runId} could not be resumed in ${MAX_RESUME_ATTEMPTS} attempts. Last error: ${message}`;
}

/** Atomically retire the exact answer generation and fail its run. */
export async function terminalizeExhaustedResume(
  db: Db,
  row: ResumeAttemptSubject,
  answeredAt: Date,
  error: unknown,
): Promise<boolean> {
  const reason = failureReason(row, resumeErrorMessage(error));
  const result = await db.execute(sql`
    WITH terminal_clarification AS (
      UPDATE clarification_requests
      SET status = 'resume_failed'
      WHERE id = ${row.id}
        AND status = 'answered'
        AND resume_attempts >= ${MAX_RESUME_ATTEMPTS}
        AND answered_at = ${answeredAt}
        AND EXISTS (
          SELECT 1 FROM workflow_runs WHERE workflow_runs.run_id = ${row.runId}
        )
      RETURNING id, run_id
    ), failed_run AS (
      UPDATE workflow_runs
      SET status = 'failed',
          status_reason = ${reason},
          completed_at = coalesce(completed_at, now()),
          duration_sec = coalesce(
            duration_sec,
            case
              when coalesce(started_at, created_at) is not null
              then greatest(0, extract(epoch from (now() - coalesce(started_at, created_at)))::int)
              else null
            end
          ),
          updated_at = now()
      FROM terminal_clarification
      WHERE workflow_runs.run_id = terminal_clarification.run_id
        AND coalesce(workflow_runs.status, 'running')
          NOT IN ('success', 'failed', 'blocked')
      RETURNING workflow_runs.run_id
    )
    SELECT terminal_clarification.id
    FROM terminal_clarification
    LEFT JOIN failed_run ON failed_run.run_id = terminal_clarification.run_id
  `);
  const rows = (result as { rows?: Array<{ id: string }> }).rows ?? [];
  return rows.length === 1;
}

type FailedResumeInput = {
  db: Db;
  row: ResumeAttemptSubject;
  reservation: ResumeAttemptReservation;
  issueTracker: Pick<IssueTrackerAdapter, "fetchTicket" | "moveTicket" | "postComment">;
  error: unknown;
};

async function cancelExhaustedResume(input: FailedResumeInput): Promise<void> {
  const { db, row } = input;
  const cancellation = await cancelRunForOperator(db, row.runId, {
    actorLabel: "clarification resume failure",
    runRegistry: new PostgresRunRegistry(db),
    issueTracker: input.issueTracker as IssueTrackerAdapter,
  }).catch((cancelError: unknown) => {
    logger.warn(
      {
        ticketKey: row.ticketKey ?? "",
        runId: row.runId,
        error: cancelError instanceof Error ? cancelError.message : String(cancelError),
      },
      "clarification_resume_exhausted_cancel_failed",
    );
    return null;
  });
  if (cancellation?.outcome === "unconfirmed") {
    logger.warn(
      { ticketKey: row.ticketKey ?? "", runId: row.runId },
      "clarification_resume_exhausted_cancel_unconfirmed",
    );
  }
}

async function postExhaustedResumeComment(
  input: FailedResumeInput,
  message: string,
): Promise<void> {
  if (!input.row.ticketKey) return;
  await input.issueTracker
    .postComment(
      input.row.ticketKey,
      formatClarificationResumeFailedComment({
        attempts: MAX_RESUME_ATTEMPTS,
        error: message,
      }),
    )
    .catch((commentError: unknown) => {
      logger.warn(
        {
          ticketKey: input.row.ticketKey,
          runId: input.row.runId,
          error: commentError instanceof Error ? commentError.message : String(commentError),
        },
        "clarification_resume_exhausted_comment_failed",
      );
    });
}

/** Finish a failed reserved delivery, including terminal side effects. */
export async function finishFailedResume(
  input: FailedResumeInput,
): Promise<"retryable" | "exhausted" | "lost"> {
  if (input.reservation.attempt < MAX_RESUME_ATTEMPTS) return "retryable";

  const { db, row, error } = input;
  const message = resumeErrorMessage(error);
  const transitioned = await terminalizeExhaustedResume(
    db,
    row,
    input.reservation.answeredAt,
    error,
  );
  if (!transitioned) return "lost";

  await cancelExhaustedResume(input);
  await postExhaustedResumeComment(input, message);

  logger.warn(
    {
      ticketKey: row.ticketKey ?? "",
      runId: row.runId,
      clarificationId: row.id,
      error: message,
    },
    "clarification_resume_exhausted",
  );
  return "exhausted";
}
