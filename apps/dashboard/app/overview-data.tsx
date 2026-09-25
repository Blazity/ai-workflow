// apps/dashboard/app/overview-data.tsx
import { getJSON, withQuery, authAwareFallback } from "@/lib/api/server";
import type { TimeWindow } from "@/lib/window";
import {
  OverviewScreen,
  type OverviewScreenData,
} from "@/components/cockpit/screens/overview";
import { OverviewMobileScreen } from "@/components/cockpit/mobile/screens/overview-mobile";
import type {
  KpisResponse,
  LiveRunsResponse,
  DispatchCapacityResponse,
  RunsResponse,
  WorkflowsResponse,
} from "@shared/contracts";
import {
  kpisFallback,
  recentRunsFallback,
  liveRunsFallback,
  dispatchCapacityFallback,
  workflowsFallback,
} from "@/lib/api/fallbacks";
import { deriveKpisFromRuns } from "@/lib/api/derive-kpis";
import { mergeLiveRuns } from "@/lib/merge-live-runs";

export async function OverviewData({ window }: { window: TimeWindow }) {
  const now = new Date().toISOString();

  // Window scopes the historical aggregates (KPIs, recent runs, workflows).
  // Live runs (registry) are not windowed here.
  const [kpis, recentRuns, liveRuns, capacity, workflows] =
    await Promise.all([
      getJSON<KpisResponse>(withQuery("/api/v1/overview/kpis", { window })).catch(
        (e) => authAwareFallback(e, () => kpisFallback(now)),
      ),
      getJSON<RunsResponse>(withQuery("/api/v1/runs", { window })).catch((e) =>
        authAwareFallback(e, () => recentRunsFallback(now)),
      ),
      getJSON<LiveRunsResponse>("/api/v1/runs/live").catch((e) =>
        authAwareFallback(e, () => liveRunsFallback(now)),
      ),
      getJSON<DispatchCapacityResponse>("/api/v1/dispatch/capacity").catch((e) =>
        authAwareFallback(e, () => dispatchCapacityFallback(now)),
      ),
      getJSON<WorkflowsResponse>(withQuery("/api/v1/workflows", { window })).catch(
        (e) => authAwareFallback(e, () => workflowsFallback(now)),
      ),
    ]);

  // The worker's KPI endpoint returns null when its run-store fetch is rejected
  // (page-size cap). Derive the tiles from the runs list we already have so the
  // overview shows live counts instead of N/A. Per field: worker data wins when
  // present, derived fills the gaps.
  const derived = recentRuns.available
    ? deriveKpisFromRuns(recentRuns, kpis.generatedAt)
    : null;
  const mergedKpis: KpisResponse = derived
    ? {
        generatedAt: kpis.generatedAt,
        runs24h: kpis.runs24h ?? derived.runs24h,
        p95: kpis.p95 ?? derived.p95,
        errors24h: kpis.errors24h ?? derived.errors24h,
        cost24h: kpis.cost24h ?? derived.cost24h,
      }
    : kpis;

  // One list for every card, merged the way runs-data.tsx feeds the Runs page
  // (see mergeLiveRuns): the store stays authoritative for a finished run, and
  // the open runs the live board adds are counted once, in the live panels and
  // the Recent runs card alike.
  const data: OverviewScreenData = {
    kpis: mergedKpis,
    runs: mergeLiveRuns(recentRuns, liveRuns),
    capacity,
    workflows,
  };
  return (
    <>
      <div className="hidden lg:block"><OverviewScreen data={data} window={window} /></div>
      <div className="lg:hidden"><OverviewMobileScreen data={data} window={window} /></div>
    </>
  );
}
