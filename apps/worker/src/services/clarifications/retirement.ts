import {
  supersedeClarification,
  supersedePendingForTicket,
} from "../../db/repositories/clarifications.js";
import { markRunBlockedOnCancel } from "../../db/repositories/runs/telemetry.js";
import type { HookClarificationRow } from "../../db/repositories/clarification-hooks.js";

type Db = Parameters<typeof supersedeClarification>[0];

/**
 * Best-effort teardown when a clarification's Jira ticket has been deleted:
 * supersede sibling questions, supersede this row, and settle the parked run so
 * it does not stay awaiting forever. Each step swallows its own error.
 *
 * The run is settled as "blocked", not "success": it is still suspended on a
 * hook whose question was just superseded, so nobody can answer it and it will
 * never reach a PR. Recording success would freeze that dead run into a green
 * result the cron can no longer correct.
 */
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
