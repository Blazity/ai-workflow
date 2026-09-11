import { defineEventHandler } from "h3";
import type { RepositoriesResponse } from "@shared/contracts";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../services/auth/request-context.js";
import {
  listRepositoryDirectory,
} from "../../../services/repository-discovery/directory.js";

const CACHE_TTL_MS = 60_000;

let cache: { at: number; response: RepositoriesResponse } | null = null;

export function resetRepositoriesCacheForTests(): void {
  cache = null;
}

export default defineEventHandler(async (event): Promise<RepositoriesResponse | undefined> => {
  try {
    await requireDashboardActor(event);
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      return cache.response;
    }
    const response = await listRepositoryDirectory();
    cache = { at: Date.now(), response };
    return response;
  } catch (error) {
    toHttpError(error);
  }
});
