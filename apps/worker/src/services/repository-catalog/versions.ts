/**
 * A repository's profile history, and the profile the engine currently
 * resolves for it.
 *
 * Reads only. Writing a profile is `saveRepositoryProfile` in this cluster's
 * index, which is one statement in the repository tier; nothing here appends.
 */
import {
  repositoryCatalogKey,
  type RepositoryProfileVersion,
  type RepositoryRelationship,
} from "@shared/contracts";
import {
  listConnectedRepositoriesWithProfiles,
  listConnectedRepositoryProfileVersionRows,
  type RepositoryProfileVersionRow,
} from "../../db/repositories/repository-catalog.js";

export function serializeRepositoryProfileVersion(
  row: RepositoryProfileVersionRow,
): RepositoryProfileVersion {
  return {
    version: row.version,
    description: row.description,
    rules: row.rules,
    relationships: (row.relationships ?? []) as RepositoryRelationship[],
    scriptGroups: (row.scriptGroups ?? null) as Record<string, unknown> | null,
    gateGroups: (row.gateGroups ?? null) as string[] | null,
    actorId: row.actorId,
    actorLabel: row.actorLabel,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listRepositoryProfileVersions(
  repositoryId: number,
): Promise<RepositoryProfileVersion[]> {
  const rows = await listConnectedRepositoryProfileVersionRows(repositoryId);
  return rows.map(serializeRepositoryProfileVersion);
}

/**
 * The profile a repository key currently resolves to, or null when the key
 * names no row, or a row nobody has given a profile.
 *
 * Keyed rather than taken by id because the callers that ask this question hold
 * a `provider:owner/name` and not a database id: a run knows which repositories
 * it is working in, never which rows they are.
 */
export async function getCurrentRepositoryProfile(
  key: string,
): Promise<RepositoryProfileVersion | null> {
  const wanted = key.toLowerCase();
  const rows = await listConnectedRepositoriesWithProfiles();
  for (const row of rows) {
    if (repositoryCatalogKey(row.repository) !== wanted) continue;
    return row.profile ? serializeRepositoryProfileVersion(row.profile) : null;
  }
  return null;
}
