// apps/dashboard/app/trace-data.tsx
import { getJSON, authAwareFallback } from "@/lib/api/server";
import { TraceScreen } from "@/components/cockpit/screens/trace";
import type {
  RunDetailResponse,
  WorkflowRunReplayResponse,
} from "@shared/contracts";
import {
  runDetailFallback,
  runReplayFallback,
} from "@/lib/api/fallbacks";

export async function TraceData({ runId }: { runId: string }) {
  const now = new Date().toISOString();
  const [data, replay] = await Promise.all([
    getJSON<RunDetailResponse>(
      `/api/v1/runs/${encodeURIComponent(runId)}`,
    ).catch((error) =>
      authAwareFallback(error, () => runDetailFallback(now)),
    ),
    getJSON<WorkflowRunReplayResponse>(
      `/api/v1/runs/${encodeURIComponent(runId)}/replay?limit=100`,
    ).catch((error) =>
      authAwareFallback(error, () => runReplayFallback()),
    ),
  ]);
  return <TraceScreen runId={runId} data={data} replay={replay} />;
}
