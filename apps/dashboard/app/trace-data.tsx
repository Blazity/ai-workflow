// apps/dashboard/app/trace-data.tsx
import { getJSON } from "@/lib/api/server";
import { TraceScreen } from "@/components/cockpit/screens/trace";
import type { RunDetailResponse } from "@shared/contracts";
import { runDetailFallback } from "@/lib/api/fallbacks";

export async function TraceData({ runId }: { runId: string }) {
  const now = new Date().toISOString();
  const data = await getJSON<RunDetailResponse>(
    `/api/v1/runs/${encodeURIComponent(runId)}`,
  ).catch(() => runDetailFallback(now));
  return <TraceScreen runId={runId} data={data} />;
}
