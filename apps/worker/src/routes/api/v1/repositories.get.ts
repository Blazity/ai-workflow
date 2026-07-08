import { defineEventHandler } from "h3";
import type { RepositoriesResponse, RepositoryOption } from "@shared/contracts";
import { getConfiguredVcsProviders } from "../../../../env.js";
import { createRepositoryDirectoryForProviders } from "../../../adapters/vcs/repository-directory.js";
import { requireDashboardActor, toHttpError } from "../../../lib/auth/request-context.js";

const CACHE_TTL_MS = 60_000;

let cache: { at: number; repositories: RepositoryOption[] } | null = null;

export function resetRepositoriesCacheForTests(): void {
  cache = null;
}

export default defineEventHandler(async (event): Promise<RepositoriesResponse | undefined> => {
  try {
    await requireDashboardActor(event);
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      return { repositories: cache.repositories };
    }
    const directory = createRepositoryDirectoryForProviders(getConfiguredVcsProviders());
    const repositories = (await directory.listRepositories()).map(
      (repo): RepositoryOption => ({
        provider: repo.provider,
        repoPath: repo.repoPath,
        name: repo.name,
        owner: repo.owner,
        defaultBranch: repo.defaultBranch,
        private: repo.private,
        archived: repo.archived,
      }),
    );
    cache = { at: Date.now(), repositories };
    return { repositories };
  } catch (error) {
    toHttpError(error);
  }
});
