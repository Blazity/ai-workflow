import { defineEventHandler } from "h3";
import type { RepositoriesResponse } from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../services/auth/request-context.js";
import {
  listCachedRepositoryDirectory,
  resetRepositoryDirectoryCacheForTests,
} from "../../../services/repository-discovery/directory.js";

/** Kept as this module's own export because the route's tests reset it by this
 *  name. The cache itself moved into the discovery service, where the import
 *  preview and the import commit share it rather than each listing every
 *  provider again. */
export function resetRepositoriesCacheForTests(): void {
  resetRepositoryDirectoryCacheForTests();
}

export default defineEventHandler(async (event): Promise<RepositoriesResponse | undefined> => {
  try {
    await requireDashboardActor(event);
    return await listCachedRepositoryDirectory();
  } catch (error) {
    toHttpError(error);
  }
});
