// apps/dashboard/app/runs-data.tsx
import { getJSON, withQuery } from "@/lib/api/server";
import type { TimeWindow } from "@/lib/window";
import { RunsScreen } from "@/components/cockpit/screens/runs";
import { RunsMobileScreen } from "@/components/cockpit/mobile/screens/runs-mobile";
import type { RunsResponse, LiveRunsResponse } from "@shared/contracts";
import { recentRunsFallback, liveRunsFallback } from "@/lib/api/fallbacks";
import { mergeLiveRuns } from "@/lib/merge-live-runs";

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
