// apps/dashboard/app/prompts-data.tsx
import { getJSON, authAwareFallback } from "@/lib/api/server";
import { PromptsScreen } from "@/components/cockpit/screens/prompts";
import type { PromptsResponse } from "@shared/contracts";
import { promptsFallback } from "@/lib/api/fallbacks";

export async function PromptsData() {
  const now = new Date().toISOString();
  const data = await getJSON<PromptsResponse>("/api/v1/prompts").catch((e) =>
    authAwareFallback(e, () => promptsFallback(now)),
  );
  return <PromptsScreen data={data} />;
}
