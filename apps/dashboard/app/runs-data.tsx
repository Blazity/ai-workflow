// apps/dashboard/app/runs-data.tsx
import { getJSON, withQuery } from "@/lib/api/server";
import type { TimeWindow } from "@/lib/window";
import { RunsScreen } from "@/components/cockpit/screens/runs";
import { RunsMobileScreen } from "@/components/cockpit/mobile/screens/runs-mobile";
import type { RunsResponse, LiveRunsResponse } from "@shared/contracts";
import { recentRunsFallback, liveRunsFallback } from "@/lib/api/fallbacks";

/**
 * The run store (`/api/v1/runs`) only holds historical/completed runs — in-flight
 * `running`/`awaiting` runs live in the ticket tracker and are exposed via
 * `/api/v1/runs/live`. Merge them so the runs screen's status filters (notably
 * "Awaiting input") reflect live state, matching the overview's Input-needed panel.
 */
function mergeLiveRuns(runs: RunsResponse, live: LiveRunsResponse): RunsResponse {
  const liveRows = live.rows;
  if (liveRows.length === 0) return runs;

  const liveIds = new Set(liveRows.map((r) => r.id));
  // Live rows are the current truth for in-flight runs; drop any stale run-store
  // copy with the same id, then list live runs first (most recent activity on top).
  const rows = [...liveRows, ...runs.rows.filter((r) => !liveIds.has(r.id))];

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

export async function RunsData({
  window,
  q,
}: {
  window: TimeWindow;
  q: string;
}) {
  const now = new Date().toISOString();
  const [runs, live] = await Promise.all([
    getJSON<RunsResponse>(withQuery("/api/v1/runs", { window, q })).catch(() =>
      recentRunsFallback(now),
    ),
    getJSON<LiveRunsResponse>("/api/v1/runs/live").catch(() => liveRunsFallback(now)),
  ]);
  // Live runs come from the registry (not searchable server-side); when a search
  // is active, filter them client-side so the merged view matches the query.
  const needle = q.trim().toLowerCase();
  const liveFiltered: LiveRunsResponse = needle
    ? {
        ...live,
        rows: live.rows.filter(
          (r) =>
            r.ticket.toLowerCase().includes(needle) ||
            r.ticketTitle.toLowerCase().includes(needle),
        ),
      }
    : live;
  const data = mergeLiveRuns(runs, liveFiltered);
  return (
    <>
      <div className="hidden lg:block"><RunsScreen data={data} window={window} q={q} /></div>
      <div className="lg:hidden"><RunsMobileScreen data={data} window={window} q={q} /></div>
    </>
  );
}
