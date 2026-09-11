import type { RunBlockStatusSnapshot, RunStatus } from "@shared/contracts";
import type { Db } from "../../db/types.js";
import {
  findLastBlockStatusRow,
  findLiveBlockStatusRow,
} from "../../db/repositories/runs.js";
import type { RunRegistryAdapter } from "../../adapters/run-registry/types.js";

const RUN_STATUSES = new Set<RunStatus>(["success", "running", "failed", "blocked", "awaiting"]);

function coerceStatus(status: string | null): RunStatus {
  return status && RUN_STATUSES.has(status as RunStatus) ? status as RunStatus : "running";
}

export interface CollectBlockStatusesOptions {
  registry: RunRegistryAdapter;
  db?: Db;
  /** When set, restrict both the live and last queries to this definition. */
  definitionId?: number;
}

/**
 * Statuses `workflow_runs.status` reports once a run has finished; mirrors
 * apps/dashboard/lib/merge-live-runs.ts's TERMINAL_STATUSES. The run registry
 * unregisters a run asynchronously, so a still-bound/parking/parked entry can
 * outlive the run it points to: its own row may already carry one of these.
 * A null status (not yet snapshotted) counts as in-flight, not terminal.
 */
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
    const row = await findLiveBlockStatusRow(db, {
      runIds: liveRunIds,
      definitionId,
    });
    if (row) return toSnapshot(row, "live");
  }

  const row = await findLastBlockStatusRow(db, definitionId);
  if (row) return toSnapshot(row, "last");

  return null;
}

function toSnapshot(
  row: NonNullable<Awaited<ReturnType<typeof findLastBlockStatusRow>>>,
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
