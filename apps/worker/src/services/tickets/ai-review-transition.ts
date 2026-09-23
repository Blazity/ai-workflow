import type { Db } from "../../db/types.js";
import {
  hasConnectedDurableRunPublication,
  hasDurableRunPublication,
  isConnectedRunRecordedFailed,
  isConnectedRunRecordedSucceeded,
  isRunRecordedFailed,
  isRunRecordedSucceeded,
} from "../../db/repositories/runs.js";

/**
 * Why a run was cancelled when its ticket reached the review column before any
 * of its work was published. A person reads it on the ticket, so it names the
 * tracker they moved it in; the name comes from that tracker's own manifest
 * rather than being written here.
 */
export function prematureAiReviewCancellationReason(trackerName: string): string {
  return `${trackerName} AI Review transition before durable PR publication evidence`;
}

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

export async function decideConnectedAiReviewRun(
  runId: string,
): Promise<AiReviewRunDecision> {
  try {
    if (await isConnectedRunRecordedFailed(runId)) return "retain";
    if (await isConnectedRunRecordedSucceeded(runId)) return "retain";
    return (await hasConnectedDurableRunPublication(runId)) ? "retain" : "cancel";
  } catch {
    return "lookup_failed";
  }
}
