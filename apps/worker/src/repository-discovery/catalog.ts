import type { RepositoryMetadata } from "../adapters/vcs/repository-directory.js";

export const MAX_ACCESSIBLE_REPOSITORIES = 200;
const MAX_DESCRIPTION_LENGTH = 240;
const MAX_TOPIC_COUNT = 8;
const MAX_TOPIC_LENGTH = 40;

export interface RepositoryCatalogEntry {
  provider: RepositoryMetadata["provider"];
  repoPath: string;
  name: string;
  defaultBranch: string;
  description: string;
  topics: string[];
  usable: boolean;
  unusableReason?: "missing_default_branch";
}

export class RepositoryCatalogError extends Error {
  constructor(
    message: string,
    readonly code:
      | "catalog_limit_exceeded"
      | "invalid_repository_path",
  ) {
    super(message);
    this.name = "RepositoryCatalogError";
  }
}

export function buildRepositoryCatalog(
  repositories: RepositoryMetadata[],
): RepositoryCatalogEntry[] {
  const available = repositories.filter((repository) => !repository.archived);
  if (available.length > MAX_ACCESSIBLE_REPOSITORIES) {
    throw new RepositoryCatalogError(
      `Accessible repository catalog exceeds ${MAX_ACCESSIBLE_REPOSITORIES} entries`,
      "catalog_limit_exceeded",
    );
  }

  return toCatalogEntries(available);
}

// Unbounded variant for deterministic repository selection, which must not fail
// on catalog size. The bounded `buildRepositoryCatalog` remains the only path
// that hands a catalog to model discovery or expansion.
export function buildRepositoryCatalogEntries(
  repositories: RepositoryMetadata[],
): RepositoryCatalogEntry[] {
  return toCatalogEntries(
    repositories.filter((repository) => !repository.archived),
  );
}

function toCatalogEntries(
  available: RepositoryMetadata[],
): RepositoryCatalogEntry[] {
  return available
    .map((repository) => {
      if (!isValidProviderPath(repository.provider, repository.repoPath)) {
        throw new RepositoryCatalogError(
          `Invalid ${repository.provider} repository path: ${repository.repoPath}`,
          "invalid_repository_path",
        );
      }
      const defaultBranch = repository.defaultBranch.trim();
      return {
        provider: repository.provider,
        repoPath: repository.repoPath,
        name: repository.name.slice(0, 100),
        defaultBranch,
        description: repository.description.slice(0, MAX_DESCRIPTION_LENGTH),
        topics: repository.topics
          .slice(0, MAX_TOPIC_COUNT)
          .map((topic) => topic.slice(0, MAX_TOPIC_LENGTH)),
        usable: defaultBranch.length > 0,
        ...(defaultBranch.length === 0
          ? { unusableReason: "missing_default_branch" as const }
          : {}),
      };
    })
    .sort((left, right) =>
      repositoryCatalogKey(left).localeCompare(repositoryCatalogKey(right)),
    );
}

export function repositoryCatalogKey(
  repository: Pick<RepositoryCatalogEntry, "provider" | "repoPath">,
): string {
  return `${repository.provider}:${repository.repoPath.toLowerCase()}`;
}

function isValidProviderPath(
  provider: RepositoryMetadata["provider"],
  repoPath: string,
): boolean {
  const segments = repoPath.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9_.-]+$/.test(segment),
    )
  ) {
    return false;
  }
  return provider === "github" ? segments.length === 2 : segments.length >= 2;
}
