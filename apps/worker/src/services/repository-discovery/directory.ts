/**
 * The repository picker's view of every provider this deployment is wired to.
 *
 * A provider that is not configured and a provider whose listing failed are two
 * different answers, and neither is an error: the picker still opens on whatever
 * catalog survived. The provider list is the fixed supported set rather than the
 * configured set, so a provider nobody connected still appears, explained.
 */
import type {
  RepositoriesResponse,
  RepositoryOption,
  RepositoryProviderStatus,
  VcsProviderKind,
} from "@shared/contracts";
import { listRepositoriesAcrossProviders } from "../../adapters/vcs/repository-directory.js";
import { configuredVcsProviders } from "../settings/index.js";

const SUPPORTED_PROVIDERS: VcsProviderKind[] = ["github", "gitlab"];

/** Every listable repository, plus one status per supported provider. */
export async function listRepositoryDirectory(): Promise<RepositoriesResponse> {
  const configured = configuredVcsProviders();
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
  return { repositories, providers };
}

/**
 * How long one listing is reused. A minute, as the repositories route has
 * always cached it.
 *
 * Short because the list changes when somebody creates a repository and the
 * admin who just created it is the one reloading the picker; long enough that
 * opening the picker, previewing an import and committing it is ONE listing
 * rather than three. Process local, so it is per worker instance, and the worst
 * a stale entry costs is a repository that appears a minute late.
 */
const DIRECTORY_CACHE_TTL_MS = 60_000;

let cache: { at: number; response: RepositoriesResponse } | null = null;

/**
 * The directory, from cache when it is fresh.
 *
 * One cache for every caller, deliberately. The picker route, the import
 * preview and the import commit all ask the same providers the same question,
 * and three separate caches would let a preview and the commit that follows it
 * disagree about which repositories exist, which is exactly the disagreement
 * the commit reports back as "skipped".
 */
export async function listCachedRepositoryDirectory(): Promise<RepositoriesResponse> {
  if (cache && Date.now() - cache.at < DIRECTORY_CACHE_TTL_MS) {
    return cache.response;
  }
  const response = await listRepositoryDirectory();
  cache = { at: Date.now(), response };
  return response;
}

/** Drop the cached listing. Tests only: the cache is module state and a suite
 *  that left one behind would answer the next test from the previous test's
 *  providers. */
export function resetRepositoryDirectoryCacheForTests(): void {
  cache = null;
}
