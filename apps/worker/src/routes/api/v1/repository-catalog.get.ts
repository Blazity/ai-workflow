import { defineEventHandler } from "h3";
import type { RepositoryCatalogListResponse } from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../services/auth/request-context.js";
import { readRepositoryCatalog } from "../../../services/repository-catalog/index.js";

/**
 * The Repositories screen, in one call.
 *
 * Open to every dashboard role. Knowing which repositories this deployment
 * touches is not a privilege: a member can already read every run that worked
 * in them, and a list they cannot see is a list they cannot report a problem
 * with. Only the writes below are owner-or-admin.
 *
 * Deliberately not the provider directory (`repositories.get.ts`): that route
 * lists what the installation can see, with its own one-minute cache, and feeds
 * the editor's picker. This one lists what the deployment has decided about.
 */
export default defineEventHandler(
  async (event): Promise<RepositoryCatalogListResponse | undefined> => {
    try {
      await requireDashboardActor(event);
      return await readRepositoryCatalog();
    } catch (error) {
      toHttpError(error);
    }
  },
);
