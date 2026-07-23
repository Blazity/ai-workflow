import { authAwareFallback, getJSON } from "@/lib/api/server";
import { requireSession } from "@/lib/auth/session";
import { HarnessProfilesScreen } from "@/components/cockpit/screens/harness-profiles";
import type { HarnessProfilesResponse } from "@shared/contracts";

export async function HarnessProfilesData() {
  await requireSession();
  const loaded = await getJSON<HarnessProfilesResponse>(
    "/api/v1/harness-profiles?includeArchived=1",
  ).catch((error) =>
    authAwareFallback(error, (): HarnessProfilesResponse | null => null),
  );

  return (
    <HarnessProfilesScreen
      initial={loaded ?? { profiles: [], canManageProfiles: false }}
      available={loaded !== null}
    />
  );
}
