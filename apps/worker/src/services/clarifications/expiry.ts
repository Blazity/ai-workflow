import { getHookByToken, resumeHook } from "workflow/api";
import type { Db } from "../../db/types.js";
import {
  listConnectedExpiredPendingHookClarifications,
  listExpiredPendingHookClarifications,
  recordConnectedHookClarificationCleanup,
  recordHookClarificationCleanup,
  retireConnectedPendingHookClarification,
  retirePendingHookClarification,
} from "../../db/repositories/clarifications.js";
import { deleteClarificationSnapshotStep } from "../../engine/steps/clarification-snapshot-steps.js";

export async function expireHookClarifications(
  db: Db,
  now = new Date(),
): Promise<{ expired: number; retryable: number; cleanupFailed: number }> {
  return expireHookClarificationsWithStore({
    list: (at) => listExpiredPendingHookClarifications(db, at),
    retire: (id) => retirePendingHookClarification(db, id),
    recordCleanup: (input) => recordHookClarificationCleanup(db, input),
  }, now);
}

export function expireConnectedHookClarifications(
  now = new Date(),
): Promise<{ expired: number; retryable: number; cleanupFailed: number }> {
  return expireHookClarificationsWithStore({
    list: listConnectedExpiredPendingHookClarifications,
    retire: retireConnectedPendingHookClarification,
    recordCleanup: recordConnectedHookClarificationCleanup,
  }, now);
}

async function expireHookClarificationsWithStore(
  store: {
    list: typeof listConnectedExpiredPendingHookClarifications;
    retire: typeof retireConnectedPendingHookClarification;
    recordCleanup: typeof recordConnectedHookClarificationCleanup;
  },
  now: Date,
): Promise<{ expired: number; retryable: number; cleanupFailed: number }> {
  const candidates = await store.list(now);

  let expired = 0;
  let retryable = 0;
  let cleanupFailed = 0;
  for (const candidate of candidates) {
    const token = candidate.hookToken;
    if (!token) continue;
    try {
      await resumeHook(token, { expired: true });
    } catch {
      const stillWaiting = await getHookByToken(token)
        .then(() => true)
        .catch(() => false);
      if (stillWaiting) {
        retryable += 1;
        continue;
      }
    }

    if (!(await store.retire(candidate.id))) continue;
    expired += 1;

    if (candidate.snapshotId) {
      let cleanup: { id: string; state: "deleted" | "failed"; error: string | null };
      try {
        await deleteClarificationSnapshotStep(candidate.snapshotId);
        cleanup = {
          id: candidate.id,
          state: "deleted",
          error: null,
        };
      } catch (error) {
        cleanupFailed += 1;
        cleanup = {
          id: candidate.id,
          state: "failed",
          error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
        };
      }
      await store.recordCleanup(cleanup);
    }
  }
  return { expired, retryable, cleanupFailed };
}
