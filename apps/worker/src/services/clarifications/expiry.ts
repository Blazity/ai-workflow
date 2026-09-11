import { getHookByToken, resumeHook } from "workflow/api";
import type { Db } from "../../db/types.js";
import {
  listConnectedExpiredPendingHookClarifications,
  listExpiredPendingHookClarifications,
  retireConnectedExpiredHookClarification,
  retireExpiredHookClarification,
} from "../../db/repositories/clarifications.js";
import { deleteClarificationSnapshotStep } from "../../engine/steps/clarification-snapshot-steps.js";

export async function expireHookClarifications(
  db: Db,
  now = new Date(),
): Promise<{ expired: number; retryable: number; cleanupFailed: number }> {
  return expireHookClarificationsWithStore({
    list: (at) => listExpiredPendingHookClarifications(db, at),
    retire: (input) => retireExpiredHookClarification(db, input),
  }, now);
}

export function expireConnectedHookClarifications(
  now = new Date(),
): Promise<{ expired: number; retryable: number; cleanupFailed: number }> {
  return expireHookClarificationsWithStore({
    list: listConnectedExpiredPendingHookClarifications,
    retire: retireConnectedExpiredHookClarification,
  }, now);
}

async function expireHookClarificationsWithStore(
  store: {
    list: typeof listConnectedExpiredPendingHookClarifications;
    retire: typeof retireConnectedExpiredHookClarification;
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

    let cleanup: { state: "deleted" | "failed"; error: string | null } | null = null;
    if (candidate.snapshotId) {
      try {
        await deleteClarificationSnapshotStep(candidate.snapshotId);
        cleanup = {
          state: "deleted",
          error: null,
        };
      } catch (error) {
        cleanup = {
          state: "failed",
          error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
        };
      }
    }
    if (!(await store.retire({ id: candidate.id, cleanup }))) continue;
    expired += 1;
    if (cleanup?.state === "failed") cleanupFailed += 1;
  }
  return { expired, retryable, cleanupFailed };
}
