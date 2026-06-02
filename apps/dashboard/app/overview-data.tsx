// apps/dashboard/app/overview-data.tsx
import { getJSON } from "@/lib/api/server";
import {
  OverviewScreen,
  type OverviewScreenData,
} from "@/components/cockpit/screens/overview";
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

  const data: OverviewScreenData = { kpis, evalHealth, liveRuns, recentRuns, workflows };
  return <OverviewScreen data={data} />;
}
