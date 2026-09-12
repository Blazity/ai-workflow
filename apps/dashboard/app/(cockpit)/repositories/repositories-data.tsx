import { canManageRepositoryCatalog } from "@shared/contracts";
import type { RepositoryCatalogListResponse } from "@shared/contracts";

import { authAwareFallback, getJSON } from "@/lib/api/server";
import { requireSession } from "@/lib/auth/session";

import { RepositoriesScreen } from "./repositories-screen";

/**
 * Reading the catalog is open to every role, so this page is not role gated;
 * only the switch, the dialogs and the entry forms are. A member can already
 * read every run that worked in these repositories, and a list they cannot see
 * is a list they cannot report a problem with.
 */
export async function RepositoriesData() {
  const session = await requireSession();

  const catalog = await getJSON<RepositoryCatalogListResponse>(
    "/api/v1/repository-catalog",
  ).catch((error) =>
    authAwareFallback(error, (): RepositoryCatalogListResponse | null => null),
  );

  return (
    <RepositoriesScreen
      state={catalog?.state ?? null}
      repositories={catalog?.repositories ?? []}
      canManage={canManageRepositoryCatalog(session.role)}
      available={catalog !== null}
    />
  );
}
