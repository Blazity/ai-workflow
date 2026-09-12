/**
 * Importing repositories from the connected provider into the catalog.
 *
 * Two halves on purpose. The preview is what the admin ticks boxes against and
 * is open to every role, because knowing which repositories the installation
 * exposes is not a privilege. The commit is a write and takes the catalog
 * manager role, and it is checked against the SAME listing rather than against
 * the keys it was handed: a key the installation does not expose is echoed back
 * as skipped instead of creating a catalog row for a repository nobody here can
 * reach.
 *
 * No suggestion runs on an import. Importing says the catalog knows about a
 * repository; describing it is a separate, deliberate click, because a bulk
 * import of two hundred repositories would otherwise be two hundred LLM calls
 * nobody asked for.
 */
import {
  DashboardAuthError,
  repositoryCatalogKey,
  type RepositoryCatalogImportCandidate,
  type RepositoryCatalogImportPreviewResponse,
  type RepositoryCatalogImportRequest,
  type RepositoryCatalogImportResponse,
} from "@shared/contracts";
import { importConnectedRepositoryCatalogEntries } from "../../db/repositories/repository-catalog.js";
import { listCachedRepositoryDirectory } from "../repository-discovery/index.js";
import { requireCatalogManager, type RepositoryCatalogActor } from "./authoring.js";
import { loadRepositoryCatalogEntries } from "./store.js";

/**
 * What the installation exposes, marked with what the catalog already holds.
 *
 * The listing comes from the repository picker's own service, through the cache
 * that service owns: opening the picker, previewing an import and committing it
 * within a minute is ONE listing of every provider rather than three. The cache
 * is process local, so a second worker instance asks again; what it rules out
 * is one admin's own sequence of clicks fanning out into a listing per click.
 */
export async function previewRepositoryImport(): Promise<RepositoryCatalogImportPreviewResponse> {
  const [directory, catalog] = await Promise.all([
    listCachedRepositoryDirectory(),
    // The rows, not the dispatch snapshot: "already in the catalog" is a
    // question about PRESENCE, and a repository somebody switched off is
    // present. The snapshot's enabled set would answer it wrong for exactly
    // the rows an admin is most likely to re-import by mistake.
    loadRepositoryCatalogEntries(),
  ]);
  const known = new Set(catalog.entries.map((entry) => repositoryCatalogKey(entry)));
  const repositories = directory.repositories.map(
    (repository): RepositoryCatalogImportCandidate => {
      const key = repositoryCatalogKey({
        provider: repository.provider,
        path: repository.repoPath,
      });
      return {
        key,
        provider: repository.provider,
        path: repository.repoPath,
        name: repository.name,
        owner: repository.owner,
        defaultBranch: repository.defaultBranch,
        private: repository.private,
        archived: repository.archived,
        inCatalog: known.has(key),
      };
    },
  );
  return { repositories, providers: directory.providers };
}

/**
 * Create a catalog row for each selected repository, in one statement.
 *
 * The stored path is the provider's casing, taken from the listing rather than
 * from the key the screen sent: the key is cased down so it can be compared,
 * and a row stored from it would carry a path no workspace matches.
 *
 * Every submitted key ends in exactly one of three places, and the three mean
 * different things:
 *
 * - **imported**, a row this call created;
 * - **alreadyPresent**, a row the catalog already held, so the insert did
 *   nothing for it (and in particular did not re-enable a repository somebody
 *   switched off);
 * - **skipped**, a key a SUCCESSFUL listing of its provider did not contain,
 *   which means the installation does not expose that repository any more.
 *
 * A provider that could not be listed at all makes the whole call a 503 rather
 * than filling `skipped`. "We could not ask" is not "it is not there", and
 * reporting the first as the second is how an admin reloads the screen, sees
 * eight of their ten repositories missing, and re-imports them later as
 * duplicates. The refusal is retryable and says which provider failed.
 */
export async function commitRepositoryImport(input: {
  actor: RepositoryCatalogActor;
  request: RepositoryCatalogImportRequest;
}): Promise<RepositoryCatalogImportResponse> {
  requireCatalogManager(input.actor);
  const [directory, before] = await Promise.all([
    listCachedRepositoryDirectory(),
    // Presence again, and here it decides `alreadyPresent`: a disabled row must
    // report as already present rather than be re-imported, which is what keeps
    // the insert from re-enabling a repository somebody switched off.
    loadRepositoryCatalogEntries(),
  ]);

  const requested: string[] = [];
  const seen = new Set<string>();
  for (const key of input.request.repositoryKeys) {
    const normalized = key.trim().toLowerCase();
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    requested.push(normalized);
  }

  // Refused before anything is written, and for the whole call rather than per
  // key: a partial import against a provider nobody could list would leave the
  // admin unable to tell which half of their selection was even considered.
  const unavailable = new Set(
    directory.providers
      .filter((provider) => provider.status === "error")
      .map((provider) => provider.provider as string),
  );
  const blocked = [
    ...new Set(
      requested
        .map((key) => key.slice(0, key.indexOf(":")))
        .filter((provider) => unavailable.has(provider)),
    ),
  ];
  if (blocked.length > 0) {
    throw new DashboardAuthError(503, `provider_unavailable: ${blocked.join(", ")}`);
  }

  const available = new Map(
    directory.repositories.map((repository) => [
      repositoryCatalogKey({
        provider: repository.provider,
        path: repository.repoPath,
      }),
      repository,
    ]),
  );
  const known = new Set(before.entries.map((entry) => repositoryCatalogKey(entry)));

  const selected: Array<{ provider: string; path: string }> = [];
  const skipped: string[] = [];
  const alreadyPresent: string[] = [];
  for (const key of requested) {
    const repository = available.get(key);
    if (!repository) {
      skipped.push(key);
      continue;
    }
    if (known.has(key)) {
      alreadyPresent.push(key);
      continue;
    }
    selected.push({ provider: repository.provider, path: repository.repoPath });
  }

  const imported =
    selected.length === 0
      ? 0
      : await importConnectedRepositoryCatalogEntries({
          repositories: selected,
          enabled: input.request.enabled,
        });
  const after = await loadRepositoryCatalogEntries();
  return { imported, skipped, alreadyPresent, repositories: [...after.entries] };
}
