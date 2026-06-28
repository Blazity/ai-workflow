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
  EvalHealthResponse,
  LiveRunsResponse,
  RunsResponse,
  WorkflowsResponse,
} from "@shared/contracts";
import {
  kpisFallback,
  evalHealthFallback,
  recentRunsFallback,
  liveRunsFallback,
  workflowsFallback,
} from "@/lib/api/fallbacks";
import { deriveKpisFromRuns } from "@/lib/api/derive-kpis";

export async function OverviewData({ window }: { window: TimeWindow }) {
  const now = new Date().toISOString();

  // Window scopes the historical aggregates (KPIs, recent runs, workflows).
  // Eval-health (Arthur) and live runs (registry) are not windowed here.
  const [kpis, evalHealth, recentRuns, liveRuns, workflows] = await Promise.all([
    getJSON<KpisResponse>(withQuery("/api/v1/overview/kpis", { window })).catch(
      (e) => authAwareFallback(e, () => kpisFallback(now)),
    ),
    getJSON<EvalHealthResponse>("/api/v1/overview/eval-health").catch(
      (e) => authAwareFallback(e, () => evalHealthFallback()),
    ),
    getJSON<RunsResponse>(withQuery("/api/v1/runs", { window })).catch((e) =>
      authAwareFallback(e, () => recentRunsFallback(now)),
    ),
    getJSON<LiveRunsResponse>("/api/v1/runs/live").catch((e) => authAwareFallback(e, () => liveRunsFallback(now))),
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

  const data: OverviewScreenData = {
    kpis: mergedKpis,
    evalHealth,
    liveRuns,
    recentRuns,
    workflows,
  };
  return (
    <>
      <div className="hidden lg:block"><OverviewScreen data={data} window={window} /></div>
      <div className="lg:hidden"><OverviewMobileScreen data={data} window={window} /></div>
    </>
  );
}
