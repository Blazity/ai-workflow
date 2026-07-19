import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { ActiveRunOwnerError } from "./run-control-errors.js";

export { ActiveRunOwnerError } from "./run-control-errors.js";

export interface ActiveRunOwner {
  subjectKey: string;
  ownerToken: string;
  runId: string | null;
}

/**
 * Reassert the exact owner at an irreversible provider boundary. Bound runs
 * must still own the same Workflow id; pre-start paths must still own their
 * exact reservation. Cancellation changes either state to cancelling, which
 * closes this fence before the provider is called.
 */
export async function assertActiveRunOwner(
  db: Db,
  owner: ActiveRunOwner,
): Promise<void> {
  const ownerState = owner.runId === null
    ? sql`state = 'reserved' AND run_id IS NULL`
    : sql`state = 'bound' AND run_id = ${owner.runId}`;
  const result = await db.execute(sql`
    SELECT 1 AS owner_count
    FROM active_runs
    WHERE subject_key = ${owner.subjectKey}
      AND owner_token = ${owner.ownerToken}
      AND ${ownerState}
    LIMIT 1
  `);
  if (rawRows(result).length === 0) {
    throw new ActiveRunOwnerError();
  }
}

function rawRows(result: unknown): unknown[] {
  return (result as { rows?: unknown[] }).rows ?? [];
}
