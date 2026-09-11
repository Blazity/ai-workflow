import { getHookByToken, resumeHook } from "workflow/api";
import type { Db } from "../../db/types.js";
import {
  listConnectedExpiredPendingHookClarifications,
  listExpiredPendingHookClarifications,
  recordConnectedClarificationSnapshotCleanup,
  recordClarificationSnapshotCleanup,
  supersedeConnectedPendingHookClarification,
  supersedePendingHookClarification,
} from "../../db/repositories/clarifications.js";
import { deleteClarificationSnapshotStep } from "../../engine/steps/clarification-snapshot-steps.js";

export async function expireHookClarifications(
  db: Db,
  now = new Date(),
): Promise<{ expired: number; retryable: number; cleanupFailed: number }> {
  return expireHookClarificationsWithStore({
    list: (at) => listExpiredPendingHookClarifications(db, at),
    supersede: (id) => supersedePendingHookClarification(db, id),
    cleanup: (input) => recordClarificationSnapshotCleanup(db, input),
  }, now);
}

export function expireConnectedHookClarifications(
  now = new Date(),
): Promise<{ expired: number; retryable: number; cleanupFailed: number }> {
  return expireHookClarificationsWithStore({
    list: listConnectedExpiredPendingHookClarifications,
    supersede: supersedeConnectedPendingHookClarification,
    cleanup: recordConnectedClarificationSnapshotCleanup,
  }, now);
}

async function expireHookClarificationsWithStore(
  store: {
    list: typeof listConnectedExpiredPendingHookClarifications;
    supersede: typeof supersedeConnectedPendingHookClarification;
    cleanup: typeof recordConnectedClarificationSnapshotCleanup;
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

    if (!(await store.supersede(candidate.id))) continue;
    expired += 1;

    if (candidate.snapshotId) {
      try {
        await deleteClarificationSnapshotStep(candidate.snapshotId);
        await store.cleanup({
          id: candidate.id,
          state: "deleted",
          error: null,
        });
      } catch (error) {
        cleanupFailed += 1;
        await store.cleanup({
          id: candidate.id,
          state: "failed",
          error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
        });
      }
    }
  }
  return { expired, retryable, cleanupFailed };
}
