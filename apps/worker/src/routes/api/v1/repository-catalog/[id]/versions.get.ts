import { defineEventHandler } from "h3";
import type { RepositoryCatalogVersionsResponse } from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../../services/auth/request-context.js";
import { readRepositoryCatalogVersions } from "../../../../../services/repository-catalog/index.js";
import { repositoryIdFrom } from "../route-id.js";

export default defineEventHandler(
  async (event): Promise<RepositoryCatalogVersionsResponse | undefined> => {
    try {
      await requireDashboardActor(event);
      return await readRepositoryCatalogVersions(repositoryIdFrom(event));
    } catch (error) {
      toHttpError(error);
    }
  },
);
