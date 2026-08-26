import { redirect } from "next/navigation";
import type { SystemHealthLastScanResponse } from "@shared/contracts";
import { authAwareFallback, getJSON } from "@/lib/api/server";
import { requireSession } from "@/lib/auth/session";
import { HealthScreen } from "@/components/cockpit/screens/health";

/** Loads the stored result of the last scan; a new scan runs only on the
 * Scan button. */
export async function HealthData() {
  const session = await requireSession();
  if (!session.canManageUsers) redirect("/");
  const { scan } = await getJSON<SystemHealthLastScanResponse>(
    "/api/v1/system/health",
  ).catch((err) => authAwareFallback(err, () => ({ scan: null })));
  return <HealthScreen initialData={scan} />;
}
