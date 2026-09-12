import { defineEventHandler } from "h3";
import type { RepositoryCatalogEntryResponse } from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../services/auth/request-context.js";
import { readRepositoryCatalogEntry } from "../../../../services/repository-catalog/index.js";
import { repositoryIdFrom } from "./route-id.js";

export default defineEventHandler(
  async (event): Promise<RepositoryCatalogEntryResponse | undefined> => {
    try {
      await requireDashboardActor(event);
      return await readRepositoryCatalogEntry(repositoryIdFrom(event));
    } catch (error) {
      toHttpError(error);
    }
  },
);
