import { and, eq, sql } from "drizzle-orm";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";
import type { Db } from "../db/client.js";
import { workflowRuns } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { answerClarificationAndResume } from "./answer-core.js";
import { stalledResumeRunSql, type HookClarificationRow } from "./hook-store.js";

async function claimAnsweredResume(
  db: Db,
  row: { runId: string; subjectKey: string | null; ticketKey: string | null },
): Promise<"claimed" | "in_progress" | "resumed" | "settled"> {
  const [updated] = await db
    .update(workflowRuns)
    .set({ status: "resuming", updatedAt: sql`now()` })
    .where(and(eq(workflowRuns.runId, row.runId), stalledResumeRunSql()))
    .returning({ runId: workflowRuns.runId });
  if (updated) return "claimed";

  // The run row should already exist, but claiming an older status-less run is
  // still safe. ON CONFLICT makes this the same one-winner CAS as the update.
  const [inserted] = await db
    .insert(workflowRuns)
    .values({
      runId: row.runId,
      subjectKey: row.subjectKey,
      ticketKey: row.ticketKey,
      status: "resuming",
    })
    .onConflictDoNothing()
    .returning({ runId: workflowRuns.runId });
  if (inserted) return "claimed";

  const [current] = await db
    .select({ status: workflowRuns.status })
    .from(workflowRuns)
    .where(eq(workflowRuns.runId, row.runId))
    .limit(1);
  if (current?.status === "running") return "resumed";
  if (current?.status === "resuming") return "in_progress";
  return "settled";
}

async function finishAnsweredResumeClaim(
  db: Db,
  runId: string,
  status: "awaiting" | "running" | "blocked",
): Promise<void> {
  await db
    .update(workflowRuns)
    .set({ status, updatedAt: sql`now()` })
    .where(and(eq(workflowRuns.runId, runId), eq(workflowRuns.status, "resuming")));
}

export interface AnsweredResumeResult {
  status: "resumed" | "resume_retry_pending" | "already_answered" | "ticket_gone";
  runId?: string;
}

/**
 * Redeliver an answer that was recorded but whose resume never landed (a 503 on
 * the way out, an invocation that died between the CAS and the hook call). Rides
 * answer-core's `isResumeRetry` path with the stored answer, so the answer CAS is
 * never re-run and a consumed hook counts as won: identical retries converge
 * instead of resuming a run twice.
 *
 * Lifted out of the Jira comment path unchanged, because it is not specific to
 * Jira: the same stalled resume happens to a dashboard answer and to a ticketless
 * pull request park, neither of which any comment ever reaches. The claim is what
 * keeps two callers (a webhook delivery and the poll) from resuming one run
 * twice, so every caller has to go through this and not through answer-core.
 */
export async function retryAnsweredResume(input: {
  db: Db;
  row: HookClarificationRow;
  issueTracker: IssueTrackerAdapter;
}): Promise<AnsweredResumeResult> {
  const { db, row, issueTracker } = input;
  const ticketKey = row.ticketKey;

  const claim = await claimAnsweredResume(db, row);
  if (claim === "resumed") return { status: "resumed", runId: row.runId };
  if (claim === "in_progress") {
    return { status: "resume_retry_pending", runId: row.runId };
  }
  if (claim === "settled") return { status: "already_answered", runId: row.runId };

  let outcome;
  try {
    outcome = await answerClarificationAndResume({
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
  } catch (error) {
    await finishAnsweredResumeClaim(db, row.runId, "awaiting");
    throw error;
  }
  switch (outcome.kind) {
    case "answered": {
      await finishAnsweredResumeClaim(db, row.runId, "running");
      return { status: "resumed", runId: row.runId };
    }
    case "resume_failed_retryable": {
      await finishAnsweredResumeClaim(db, row.runId, "awaiting");
      logger.warn(
        { ticketKey, runId: row.runId },
        "clarification_resume_retry_pending",
      );
      return { status: "resume_retry_pending", runId: row.runId };
    }
    case "ticket_gone": {
      await finishAnsweredResumeClaim(db, row.runId, "blocked");
      return { status: "ticket_gone" };
    }
    case "ticket_transition_failed": {
      // Nothing was committed, so release the claim and let the next delivery
      // (or the cron) retry the whole resume, transition included.
      await finishAnsweredResumeClaim(db, row.runId, "awaiting");
      logger.warn(
        { ticketKey, runId: row.runId },
        "clarification_resume_transition_retry_pending",
      );
      return { status: "resume_retry_pending", runId: row.runId };
    }
    case "conflict": {
      await finishAnsweredResumeClaim(db, row.runId, "awaiting");
      return { status: "already_answered" };
    }
    case "invalid_answer": {
      await finishAnsweredResumeClaim(db, row.runId, "awaiting");
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
