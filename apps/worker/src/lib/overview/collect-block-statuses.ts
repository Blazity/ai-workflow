import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { RunBlockStatusSnapshot } from "@shared/contracts";
import type { Db } from "../../db/client.js";
import { workflowRuns } from "../../db/schema.js";
import { coerceStatus } from "../../db/queries/runs-read.js";
import type { RunRegistryAdapter } from "../../adapters/run-registry/types.js";

export interface CollectBlockStatusesOptions {
  registry: RunRegistryAdapter;
  db: Db;
  /** When set, restrict both the live and last queries to this definition. */
  definitionId?: number;
}

/**
 * Builds the single block-status snapshot the editor canvas renders live dots
 * from. Prefers an in-flight run (a registry entry whose row carries block
 * statuses, newest first); otherwise falls back to the latest finished run
 * (success/failed) that recorded block statuses. Gate/post-PR runs never write
 * block_statuses, so the IS NOT NULL filter excludes them, and 'blocked' is
 * excluded by the status filter. Returns null when nothing qualifies.
 */
export async function collectBlockStatuses(
  opts: CollectBlockStatusesOptions,
): Promise<RunBlockStatusSnapshot | null> {
  const { registry, db, definitionId } = opts;
  const definitionFilter =
    definitionId === undefined ? undefined : eq(workflowRuns.definitionId, definitionId);

  const entries = await registry.listAll();
  const liveRunIds = entries.flatMap((entry) =>
    (entry.state === "bound" ||
      entry.state === "parking" ||
      entry.state === "parked") &&
    entry.runId
      ? [entry.runId]
      : [],
  );

  if (liveRunIds.length > 0) {
    const [row] = await db
      .select()
      .from(workflowRuns)
      .where(
        and(
          inArray(workflowRuns.runId, liveRunIds),
          isNotNull(workflowRuns.blockStatuses),
          ...(definitionFilter ? [definitionFilter] : []),
        ),
      )
      .orderBy(desc(workflowRuns.updatedAt))
      .limit(1);
    if (row) return toSnapshot(row, "live");
  }

  const [row] = await db
    .select()
    .from(workflowRuns)
    .where(
      and(
        isNotNull(workflowRuns.blockStatuses),
        inArray(workflowRuns.status, ["success", "failed"]),
        ...(definitionFilter ? [definitionFilter] : []),
      ),
    )
    .orderBy(desc(sql`coalesce(${workflowRuns.completedAt}, ${workflowRuns.updatedAt})`))
    .limit(1);
  if (row) return toSnapshot(row, "last");

  return null;
}

function toSnapshot(
  row: typeof workflowRuns.$inferSelect,
  source: "live" | "last",
): RunBlockStatusSnapshot {
  return {
    runId: row.runId,
    ticketKey: row.ticketKey,
    source,
    status: coerceStatus(row.status),
    definitionVersion: row.definitionVersion,
    definitionId: row.definitionId,
    blockStatuses: row.blockStatuses ?? {},
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}
