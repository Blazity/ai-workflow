// apps/dashboard/app/cost-data.tsx
import { getJSON } from "@/lib/api/server";
import { CostScreen } from "@/components/cockpit/screens/cost";
import type { CostResponse } from "@shared/contracts";
import { costFallback } from "@/lib/api/fallbacks";

export async function CostData() {
  const now = new Date().toISOString();
  const data = await getJSON<CostResponse>("/api/v1/cost").catch(() =>
    costFallback(now),
  );
  return <CostScreen data={data} />;
}
