import { and, eq, isNotNull, lte } from "drizzle-orm";
import { getHookByToken, resumeHook } from "workflow/api";
import type { Db } from "../db/client.js";
import { clarificationRequests } from "../db/schema.js";
import { deleteClarificationSnapshotStep } from "../workflows/clarification-snapshot-steps.js";

export async function expireHookClarifications(
  db: Db,
  now = new Date(),
): Promise<{ expired: number; retryable: number; cleanupFailed: number }> {
  const candidates = await db
    .select({
      id: clarificationRequests.id,
      hookToken: clarificationRequests.hookToken,
      snapshotId: clarificationRequests.snapshotId,
    })
    .from(clarificationRequests)
    .where(
      and(
        eq(clarificationRequests.status, "pending"),
        isNotNull(clarificationRequests.hookToken),
        lte(clarificationRequests.expiresAt, now),
      ),
    );

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

    const [retired] = await db
      .update(clarificationRequests)
      .set({ status: "superseded" })
      .where(
        and(
          eq(clarificationRequests.id, candidate.id),
          eq(clarificationRequests.status, "pending"),
        ),
      )
      .returning({ id: clarificationRequests.id });
    if (!retired) continue;
    expired += 1;

    if (candidate.snapshotId) {
      try {
        await deleteClarificationSnapshotStep(candidate.snapshotId);
        await db
          .update(clarificationRequests)
          .set({ cleanupState: "deleted", cleanupError: null })
          .where(eq(clarificationRequests.id, candidate.id));
      } catch (error) {
        cleanupFailed += 1;
        await db
          .update(clarificationRequests)
          .set({
            cleanupState: "failed",
            cleanupError: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
          })
          .where(eq(clarificationRequests.id, candidate.id));
      }
    }
  }
  return { expired, retryable, cleanupFailed };
}
