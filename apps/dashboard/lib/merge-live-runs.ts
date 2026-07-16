import type { RunsResponse, LiveRunsResponse, RunStatus } from "@shared/contracts";

/**
 * Statuses the run store reports only once a run has finished. The workflow
 * writes its own authoritative success/failed on completion (recordRunUsage),
 * and the poll cron records cancellations as blocked — none of which a live
 * overlay row may override.
 */
const TERMINAL_STATUSES = new Set<RunStatus>(["success", "failed", "blocked"]);

/**
 * The run store (`/api/v1/runs`) holds the durable run rows, but in-flight state
 * is exposed live via `/api/v1/runs/live`: `running` rows from the run registry,
 * and `awaiting` rows from the durable run store joined with the pending
 * clarification (real run ids plus the question payload). The former synthetic
 * Jira scan, which fabricated `awaiting:<ticketKey>` rows, is gone.
 *
 * Merge them so the runs screen's status filters (notably "Awaiting input")
 * reflect live state, matching the overview's Input-needed panel. Live rows carry
 * the same real run id as their store copy, so they intentionally override it by id.
 */
export function mergeLiveRuns(
  runs: RunsResponse,
  live: LiveRunsResponse,
): RunsResponse {
  const liveRows = live.rows;
  if (liveRows.length === 0) return runs;

  // The store is authoritative once a run reaches a terminal status. Live rows
  // come from the run registry, which marks every entry "running" until it's
  // unregistered, so a lingering/orphaned registry entry would otherwise mask a
  // recorded success/failed/blocked as a phantom "running". Drop any live row
  // whose run already finished in the store.
  const terminalIds = new Set(
    runs.rows.filter((r) => TERMINAL_STATUSES.has(r.status)).map((r) => r.id),
  );
  const freshLive = liveRows.filter((r) => !terminalIds.has(r.id));

  const liveIds = new Set(freshLive.map((r) => r.id));
  // Live rows are the current truth for genuinely in-flight runs (running and
  // awaiting). An awaiting live row carries the same real run id as its bare store
  // copy plus the enriched question payload, so drop the store copy with that id
  // and list live runs first (most recent activity on top).
  const rows = [...freshLive, ...runs.rows.filter((r) => !liveIds.has(r.id))];

  const counts = { success: 0, running: 0, awaiting: 0, failed: 0, blocked: 0 };
  for (const r of rows) counts[r.status]++;

  return {
    generatedAt: runs.generatedAt,
    available: runs.available || liveRows.length > 0,
    rows,
    total: rows.length,
    counts,
  };
}
