// apps/dashboard/app/runs-data.tsx
import { getJSON } from "@/lib/api/server";
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

export async function RunsData() {
  const now = new Date().toISOString();
  const [runs, live] = await Promise.all([
    getJSON<RunsResponse>("/api/v1/runs").catch(() => recentRunsFallback(now)),
    getJSON<LiveRunsResponse>("/api/v1/runs/live").catch(() => liveRunsFallback(now)),
  ]);
  const data = mergeLiveRuns(runs, live);
  return (
    <>
      <div className="hidden lg:block"><RunsScreen data={data} /></div>
      <div className="lg:hidden"><RunsMobileScreen data={data} /></div>
    </>
  );
}
