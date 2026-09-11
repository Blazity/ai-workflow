import type { Db } from "../../db/types.js";
import { cancelWaitingScheduleOccurrences } from "../../db/repositories/schedule-triggers.js";

/** Why a waiting occurrence was cancelled when its schedule stopped being live. */
export const REVOKED_SCHEDULE_REASON = "schedule_revoked";

/**
 * Settle whatever a revoked schedule left waiting.
 *
 * This is the half of revocation the store does not do. pauseSchedule cancels the
 * pending occurrence in the same statement it pauses with, because pause is a
 * stop button and leaving an occurrence for the drain to start moments later
 * would break it. Revocation has exactly the same problem and is worse for being
 * reversible: remove a schedule node at 09:05 while the 09:00 occurrence waits
 * for capacity, restore the node at 20:00, and the deploy lifts the revocation
 * onto a still-pending occurrence that the drain then starts eleven hours late.
 *
 * It lives here rather than beside revokeSchedule because that module is frozen,
 * and here rather than inside the dispatcher because the deploy path revokes too
 * and importing the dispatcher from the definition store would close an import
 * cycle.
 *
 * 'cancelled' rather than a skip outcome: no policy decided this and no run
 * blocked it, a human removed the node. Ordinary revocation preserves an existing
 * provider message. Schema retirement instead replaces it so the durable row
 * states why the occurrence can never run.
 */
export async function cancelWaitingOccurrences(
  db: Db,
  scheduleId: string,
  reason: string = REVOKED_SCHEDULE_REASON,
  overwriteReason = false,
): Promise<number> {
  return cancelWaitingScheduleOccurrences(db, { scheduleId, reason, overwriteReason });
}
