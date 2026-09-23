import type {
  VcsProviderKind,
  WorkflowDefinition,
  WorkflowRepositoryScope,
} from "@shared/contracts";
import { integrationManifest, integrationsProviding } from "@integrations/registry";

export interface PinnedRepository {
  provider: VcsProviderKind;
  repoPath: string;
}

/** Workspace ceiling on pinned repositories; the worker rejects a larger pin. */
export const MAX_PINNED_REPOSITORIES = 8;

/**
 * Every version control provider this build ships, in registry order.
 *
 * The registry is the whole answer. Naming one of them here as well would list
 * it twice the day it became an integration, and the editor renders this list:
 * a duplicate is a second checkbox for the same provider.
 */
export const PINNABLE_PROVIDERS: readonly VcsProviderKind[] = integrationsProviding(
  "vcs",
).map((manifest) => manifest.id);

function compareProviders(a: VcsProviderKind, b: VcsProviderKind): number {
  const aIndex = PINNABLE_PROVIDERS.indexOf(a);
  const bIndex = PINNABLE_PROVIDERS.indexOf(b);
  if (aIndex !== -1 || bIndex !== -1) {
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    return aIndex - bIndex;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `repoPath` is stored in the case the operator picked; matching ignores case. */
function sameRepository(a: PinnedRepository, b: PinnedRepository): boolean {
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
  const providers = [...new Set(scope.providers ?? [])].sort(compareProviders);
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

/**
 * What a provider is called on screen: the name its integration gives itself.
 *
 * A stored scope can name a provider this build does not ship, and then there
 * is no name to show. The raw id is what that pin says and what the operator
 * reads next to every repository path, so it is the honest fallback; a title
 * cased word built out of the id would put a name on screen that nobody wrote
 * and that the deployment cannot be searched for.
 */
export function providerLabel(provider: VcsProviderKind): string {
  return integrationManifest(provider)?.name ?? provider;
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
    return [...pinned].sort(compareProviders);
  }
  return [...new Set(pinnedRepositories(scope).map((repository) => repository.provider))]
    .sort(compareProviders);
}

/**
 * Toolbar summary, for example "2 repos, two connected providers". Null means no pin.
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
