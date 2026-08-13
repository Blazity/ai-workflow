import type { Db } from "../db/client.js";
import {
  hasDurableRunPublication,
  isRunRecordedFailed,
  isRunRecordedSucceeded,
} from "../db/queries/runs-read.js";

export const PREMATURE_AI_REVIEW_CANCELLATION_REASON =
  "Jira AI Review transition before durable PR publication evidence";

export type AiReviewRunDecision = "retain" | "cancel" | "lookup_failed";

/**
 * Decide whether an active run can survive an AI Review transition. The
 * webhook and reconciler use this same durable evidence rule; a failed lookup
 * is distinct from absent evidence so callers can retry instead of guessing.
 */
export async function decideAiReviewRun(
  db: Db | undefined,
  runId: string,
): Promise<AiReviewRunDecision> {
  if (!db) return "lookup_failed";
  try {
    if (await isRunRecordedFailed(db, runId)) return "retain";
    if (await isRunRecordedSucceeded(db, runId)) return "retain";
    return (await hasDurableRunPublication(db, runId)) ? "retain" : "cancel";
  } catch {
    return "lookup_failed";
  }
}
