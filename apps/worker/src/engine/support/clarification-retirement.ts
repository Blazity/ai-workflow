import {
  supersedeClarification,
  supersedePendingForTicket,
} from "../../db/repositories/clarifications.js";
import { markRunBlockedOnCancel } from "../../db/repositories/runs/telemetry.js";
import type { HookClarificationRow } from "./clarification-hook-store.js";

type Db = Parameters<typeof supersedeClarification>[0];

/** Best-effort retirement when the ticket backing a parked run is gone. */
export async function retireClarificationForGoneTicket(
  db: Db,
  row: HookClarificationRow,
): Promise<void> {
  if (row.ticketKey) {
    await supersedePendingForTicket(db, row.ticketKey).catch(() => {});
  }
  await supersedeClarification(db, row.id).catch(() => {});
  await markRunBlockedOnCancel(db, row.runId).catch(() => {});
}
