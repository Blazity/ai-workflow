// apps/dashboard/app/evals-data.tsx
import { getJSON, authAwareFallback } from "@/lib/api/server";
import { EvalsScreen } from "@/components/cockpit/screens/evals";
import type { EvalsResponse } from "@shared/contracts";
import { evalsFallback } from "@/lib/api/fallbacks";

export async function EvalsData() {
  const now = new Date().toISOString();
  const data = await getJSON<EvalsResponse>("/api/v1/evals").catch((e) =>
    authAwareFallback(e, () => evalsFallback(now)),
  );
  return <EvalsScreen data={data} />;
}
