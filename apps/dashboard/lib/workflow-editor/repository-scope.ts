import type {
  VcsProviderKind,
  WorkflowDefinition,
  WorkflowRepositoryScope,
} from "@shared/contracts";

export interface PinnedRepository {
  provider: VcsProviderKind;
  repoPath: string;
}

/** Workspace ceiling on pinned repositories; the worker rejects a larger pin. */
export const MAX_PINNED_REPOSITORIES = 8;

export const PINNABLE_PROVIDERS: readonly VcsProviderKind[] = ["github", "gitlab"];

/** `repoPath` is stored in the case the operator picked; matching ignores case. */
export function sameRepository(a: PinnedRepository, b: PinnedRepository): boolean {
  return (
    a.provider === b.provider &&
    a.repoPath.toLowerCase() === b.repoPath.toLowerCase()
  );
}

export function repositoryKey(repository: PinnedRepository): string {
  return `${repository.provider}:${repository.repoPath.toLowerCase()}`;
}

/**
 * Collapses a scope to the exact shape the definition contract allows: unique
 * repositories capped at the workspace limit, providers in a stable order, and
 * absent keys instead of empty collections so an unpinned workflow serializes
 * identically to one that never had a pin.
 */
export function normalizeRepositoryScope(
  scope: WorkflowRepositoryScope,
): WorkflowRepositoryScope {
  const repositories: PinnedRepository[] = [];
  for (const candidate of scope.repositories ?? []) {
    const repoPath = candidate.repoPath.trim();
    if (repoPath === "") continue;
    const repository = { provider: candidate.provider, repoPath };
    if (repositories.some((kept) => sameRepository(kept, repository))) continue;
    if (repositories.length >= MAX_PINNED_REPOSITORIES) break;
    repositories.push(repository);
  }
  const providers = PINNABLE_PROVIDERS.filter((provider) =>
    (scope.providers ?? []).includes(provider),
  );
  return {
    ...(repositories.length > 0 ? { repositories } : {}),
    ...(providers.length > 0 ? { providers } : {}),
  };
}

export function repositoryScopeFromDefinition(
  definition: WorkflowDefinition,
): WorkflowRepositoryScope {
  return normalizeRepositoryScope(definition.repositoryScope ?? {});
}

export function isRepositoryScopeEmpty(scope: WorkflowRepositoryScope): boolean {
  return (
    (scope.repositories?.length ?? 0) === 0 && (scope.providers?.length ?? 0) === 0
  );
}

export function pinnedRepositories(
  scope: WorkflowRepositoryScope,
): readonly PinnedRepository[] {
  return scope.repositories ?? [];
}

export function isRepositoryPinned(
  scope: WorkflowRepositoryScope,
  repository: PinnedRepository,
): boolean {
  return pinnedRepositories(scope).some((pinned) =>
    sameRepository(pinned, repository),
  );
}

export function addPinnedRepositories(
  scope: WorkflowRepositoryScope,
  repositories: readonly PinnedRepository[],
): WorkflowRepositoryScope {
  return normalizeRepositoryScope({
    ...scope,
    repositories: [...pinnedRepositories(scope), ...repositories],
  });
}

export function removePinnedRepository(
  scope: WorkflowRepositoryScope,
  repository: PinnedRepository,
): WorkflowRepositoryScope {
  return normalizeRepositoryScope({
    ...scope,
    repositories: pinnedRepositories(scope).filter(
      (pinned) => !sameRepository(pinned, repository),
    ),
  });
}

export function providerLabel(provider: VcsProviderKind): string {
  return provider === "github" ? "GitHub" : "GitLab";
}

/**
 * Pinned repositories an explicit provider pin excludes. Deployment rejects such
 * a scope, so the editor has to name the offenders rather than quietly asserting
 * a provider set the pinned repositories contradict. An absent or empty provider
 * pin excludes nothing.
 */
export function contradictingPinnedRepositories(
  scope: WorkflowRepositoryScope,
): readonly PinnedRepository[] {
  const providers = scope.providers ?? [];
  if (providers.length === 0) return [];
  return pinnedRepositories(scope).filter(
    (repository) => !providers.includes(repository.provider),
  );
}

/**
 * Providers a run inherits: the explicit pin when the operator set one, and
 * otherwise the providers implied by the pinned repositories.
 */
export function effectiveScopeProviders(
  scope: WorkflowRepositoryScope,
): VcsProviderKind[] {
  const pinned = scope.providers ?? [];
  if (pinned.length > 0) {
    return PINNABLE_PROVIDERS.filter((provider) => pinned.includes(provider));
  }
  return PINNABLE_PROVIDERS.filter((provider) =>
    pinnedRepositories(scope).some(
      (repository) => repository.provider === provider,
    ),
  );
}

/**
 * Toolbar summary, for example "2 repos, GitHub + GitLab". Null means no pin.
 * A scope whose providers exclude one of its own repositories reports the
 * mismatch instead of a provider set, so the summary can never contradict the
 * repository chips it sits above.
 */
export function describeRepositoryScope(
  scope: WorkflowRepositoryScope,
): string | null {
  if (isRepositoryScopeEmpty(scope)) return null;
  const count = pinnedRepositories(scope).length;
  const repositories = count === 0 ? null : `${count} ${count === 1 ? "repo" : "repos"}`;
  if (contradictingPinnedRepositories(scope).length > 0) {
    return [repositories, "provider mismatch"].filter((part) => part !== null).join(", ");
  }
  const providers = effectiveScopeProviders(scope)
    .map(providerLabel)
    .join(" + ");
  const parts = [repositories, providers === "" ? null : providers];
  return parts.filter((part) => part !== null).join(", ");
}
