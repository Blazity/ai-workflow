// apps/dashboard/app/cost-data.tsx
import { getJSON, withQuery, authAwareFallback } from "@/lib/api/server";
import type { TimeWindow } from "@/lib/window";
import { CostScreen } from "@/components/cockpit/screens/cost";
import type { CostResponse } from "@shared/contracts";
import { costFallback } from "@/lib/api/fallbacks";

export async function CostData({ window }: { window: TimeWindow }) {
  const now = new Date().toISOString();
  const data = await getJSON<CostResponse>(
    withQuery("/api/v1/cost", { window }),
  ).catch((e) => authAwareFallback(e, () => costFallback(now)));
  return <CostScreen data={data} window={window} />;
}
