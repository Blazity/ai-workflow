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
