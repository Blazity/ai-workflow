import { redirect } from "next/navigation";
import type { SystemHealthResponse } from "@shared/contracts";
import { getJSON } from "@/lib/api/server";
import { requireSession } from "@/lib/auth/session";
import { HealthScreen } from "@/components/cockpit/screens/health";

export async function HealthData() {
  const session = await requireSession();
  if (!session.canManageUsers) redirect("/");
  const data = await getJSON<SystemHealthResponse>("/api/v1/system/health");
  return <HealthScreen data={data} />;
}
