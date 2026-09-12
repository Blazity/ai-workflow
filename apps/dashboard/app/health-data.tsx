import { redirect } from "next/navigation";
import type {
  RepositoryCatalogListResponse,
  SettingsReadResponse,
  SystemHealthLastScanResponse,
} from "@shared/contracts";
import { authAwareFallback, getJSON } from "@/lib/api/server";
import { requireSession } from "@/lib/auth/session";
import { HealthScreen } from "@/components/cockpit/screens/health";

/** Loads the stored result of the last scan; a new scan runs only on the
 * Scan button. The settings ride along so the setup overview at the top of the
 * page can say what this deployment is configured to do, not only which
 * integrations answered. */
export async function HealthData() {
  const session = await requireSession();
  if (!session.canManageUsers) redirect("/");
  const [{ scan }, settings, catalog] = await Promise.all([
    getJSON<SystemHealthLastScanResponse>("/api/v1/system/health").catch((err) =>
      authAwareFallback(err, () => ({ scan: null })),
    ),
    getJSON<SettingsReadResponse>("/api/v1/settings").catch(
      (): SettingsReadResponse | null => null,
    ),
    // Activation is the catalog state row, not the `catalog.activated` settings
    // key that nothing writes.
    getJSON<RepositoryCatalogListResponse>("/api/v1/repository-catalog").catch(
      (): RepositoryCatalogListResponse | null => null,
    ),
  ]);
  return (
    <HealthScreen
      initialData={scan}
      settings={settings?.settings ?? []}
      catalogState={catalog?.state ?? null}
    />
  );
}
