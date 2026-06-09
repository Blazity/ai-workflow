// apps/dashboard/app/evals-data.tsx
import { getJSON } from "@/lib/api/server";
import { EvalsScreen } from "@/components/cockpit/screens/evals";
import type { EvalsResponse } from "@shared/contracts";
import { evalsFallback } from "@/lib/api/fallbacks";

export async function EvalsData() {
  const now = new Date().toISOString();
  const data = await getJSON<EvalsResponse>("/api/v1/evals").catch(() =>
    evalsFallback(now),
  );
  return <EvalsScreen data={data} />;
}
