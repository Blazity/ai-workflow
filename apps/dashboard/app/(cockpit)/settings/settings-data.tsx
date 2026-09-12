import { canEditSettings } from "@shared/contracts";
import type {
  SettingsReadResponse,
  SystemHealthLastScanResponse,
} from "@shared/contracts";

import { authAwareFallback, getJSON } from "@/lib/api/server";
import { ForbiddenError } from "@/lib/auth/errors";
import { requireSession } from "@/lib/auth/session";

import { SettingsScreen } from "./settings-screen";

/**
 * Reading the settings is open to every role, so this page is not role gated;
 * only the forms are. The system health scan is not: a member's session gets a
 * 403 from it, which is why the overview is told whether the scan was readable
 * rather than being handed a null it would report as "no scan yet".
 */
export async function SettingsData() {
  const session = await requireSession();

  const settings = await getJSON<SettingsReadResponse>("/api/v1/settings").catch(
    (error) => authAwareFallback(error, (): SettingsReadResponse | null => null),
  );

  let scanReadable = true;
  const health = await getJSON<SystemHealthLastScanResponse>(
    "/api/v1/system/health",
  ).catch((error) => {
    // A member is refused this read by design, which is a state to render, not
    // an error to raise: authAwareFallback rethrows a 403 for the pages that
    // are role gated as a whole, and this one is not.
    if (error instanceof ForbiddenError) {
      scanReadable = false;
      return { scan: null };
    }
    return authAwareFallback(error, () => ({ scan: null }));
  });

  return (
    <SettingsScreen
      settings={settings?.settings ?? []}
      scan={health.scan}
      scanReadable={scanReadable}
      canEdit={canEditSettings(session.role)}
      available={settings !== null}
    />
  );
}
