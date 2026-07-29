import { defineEventHandler } from "h3";
import type {
  RepositoriesResponse,
  RepositoryOption,
  RepositoryProviderStatus,
  VcsProviderKind,
} from "@shared/contracts";
import { getConfiguredVcsProviders } from "../../../../env.js";
import { listRepositoriesAcrossProviders } from "../../../adapters/vcs/repository-directory.js";
import { requireDashboardActor, toHttpError } from "../../../lib/auth/request-context.js";

const CACHE_TTL_MS = 60_000;

const SUPPORTED_PROVIDERS: VcsProviderKind[] = ["github", "gitlab"];

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
    const configured = getConfiguredVcsProviders();
    const listing = await listRepositoriesAcrossProviders(configured);
    const repositories = listing.repositories.map(
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
    const failures = new Map(
      listing.failures.map((failure) => [failure.provider, failure.message]),
    );
    const configuredKinds = new Set(configured.map((provider) => provider.kind));
    const providers = SUPPORTED_PROVIDERS.map(
      (provider): RepositoryProviderStatus => {
        if (!configuredKinds.has(provider)) {
          return { provider, status: "not_connected" };
        }
        const error = failures.get(provider);
        return error
          ? { provider, status: "error", error }
          : { provider, status: "ready" };
      },
    );
    const response = { repositories, providers };
    cache = { at: Date.now(), response };
    return response;
  } catch (error) {
    toHttpError(error);
  }
});
