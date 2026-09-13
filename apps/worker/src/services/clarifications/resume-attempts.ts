import type { ClarificationStatus, SettingsSnapshot } from "@shared/contracts";
import type { IssueTrackerAdapter } from "../../adapters/issue-tracker/types.js";
import {
  createConnectedPostgresRunRegistry,
  PostgresRunRegistry,
} from "../../db/repositories/active-runs.js";
import {
  reserveConnectedClarificationResumeAttempt,
  reserveClarificationResumeAttempt,
  terminalizeConnectedClarificationResume,
  terminalizeClarificationResume,
} from "../../db/repositories/clarifications.js";
import type { Db } from "../../db/types.js";
import {
  cancelConnectedRunForOperator,
  cancelRunForOperator,
} from "../run-lifecycle/index.js";
import { logger } from "../../infra/logger.js";
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
  const attempt = await reserveClarificationResumeAttempt(db, {
    id,
    answeredAt,
    maxAttempts: MAX_RESUME_ATTEMPTS,
  });
  return attempt === null
    ? null
    : { attempt, answeredAt };
}

export async function reserveConnectedResumeAttempt(
  id: string,
  answeredAt: Date,
): Promise<ResumeAttemptReservation | null> {
  const attempt = await reserveConnectedClarificationResumeAttempt({
    id,
    answeredAt,
    maxAttempts: MAX_RESUME_ATTEMPTS,
  });
  return attempt === null ? null : { attempt, answeredAt };
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
  return terminalizeClarificationResume(db, {
    id: row.id,
    runId: row.runId,
    answeredAt,
    maxAttempts: MAX_RESUME_ATTEMPTS,
    reason,
  });
}

function terminalizeConnectedExhaustedResume(
  row: ResumeAttemptSubject,
  answeredAt: Date,
  error: unknown,
): Promise<boolean> {
  return terminalizeConnectedClarificationResume({
    id: row.id,
    runId: row.runId,
    answeredAt,
    maxAttempts: MAX_RESUME_ATTEMPTS,
    reason: failureReason(row, resumeErrorMessage(error)),
  });
}

type FailedResumeInput = {
  db: Db;
  settings: Pick<SettingsSnapshot, "COLUMN_AI" | "COLUMN_BACKLOG">;
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
    settings: input.settings,
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

type ConnectedFailedResumeInput = Omit<FailedResumeInput, "db">;

async function cancelConnectedExhaustedResume(input: ConnectedFailedResumeInput): Promise<void> {
  const { row } = input;
  const cancellation = await cancelConnectedRunForOperator(row.runId, {
    actorLabel: "clarification resume failure",
    runRegistry: createConnectedPostgresRunRegistry(),
    issueTracker: input.issueTracker as IssueTrackerAdapter,
    settings: input.settings,
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
  input: Omit<FailedResumeInput, "db">,
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

/** Connected production path: the service never receives a database client. */
export async function finishConnectedFailedResume(
  input: ConnectedFailedResumeInput,
): Promise<"retryable" | "exhausted" | "lost"> {
  if (input.reservation.attempt < MAX_RESUME_ATTEMPTS) return "retryable";

  const { row, error } = input;
  const message = resumeErrorMessage(error);
  const transitioned = await terminalizeConnectedExhaustedResume(
    row,
    input.reservation.answeredAt,
    error,
  );
  if (!transitioned) return "lost";

  await cancelConnectedExhaustedResume(input);
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
