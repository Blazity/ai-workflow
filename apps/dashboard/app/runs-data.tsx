// apps/dashboard/app/runs-data.tsx
import { getJSON } from "@/lib/api/server";
import { RunsScreen } from "@/components/cockpit/screens/runs";
import type { RunsResponse } from "@shared/contracts";
import { recentRunsFallback } from "@/lib/api/fallbacks";

export async function RunsData() {
  const now = new Date().toISOString();
  const data = await getJSON<RunsResponse>("/api/v1/runs").catch(() =>
    recentRunsFallback(now),
  );
  return <RunsScreen data={data} />;
}
