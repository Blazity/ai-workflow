// apps/dashboard/app/overview-data.tsx
import { getJSON } from "@/lib/api/server";
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

export async function OverviewData() {
  const now = new Date().toISOString();

  const [kpis, evalHealth, recentRuns, liveRuns, workflows] = await Promise.all([
    getJSON<KpisResponse>("/api/v1/overview/kpis").catch(() => kpisFallback(now)),
    getJSON<EvalHealthResponse>("/api/v1/overview/eval-health").catch(
      () => evalHealthFallback(),
    ),
    getJSON<RunsResponse>("/api/v1/runs").catch(() => recentRunsFallback(now)),
    getJSON<LiveRunsResponse>("/api/v1/runs/live").catch(() => liveRunsFallback(now)),
    getJSON<WorkflowsResponse>("/api/v1/workflows").catch(() => workflowsFallback(now)),
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
      <div className="hidden lg:block"><OverviewScreen data={data} /></div>
      <div className="lg:hidden"><OverviewMobileScreen data={data} /></div>
    </>
  );
}
