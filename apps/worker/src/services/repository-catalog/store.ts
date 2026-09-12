/**
 * One immutable picture of the catalog, loaded once per entry point.
 *
 * The store is asynchronous and every consumer that decides access is not: a
 * dispatch, a webhook handler or a workflow body that awaited a database read
 * per repository would either become async all the way down or, worse, silently
 * carry a promise where a boolean was expected and treat every repository as
 * enabled. So the entry point loads this snapshot once and hands it to the
 * synchronous predicate in policy.ts.
 */
import {
  repositoryCatalogKey,
  type RepositoryCatalogEntry,
  type RepositoryCatalogSource,
  type RepositoryCatalogState,
  type RepositoryRelationship,
} from "@shared/contracts";
import {
  getConnectedRepositoryCatalogStateRow,
  listConnectedRepositoryCatalogRows,
  type RepositoryCatalogRow,
} from "../../db/repositories/repository-catalog.js";

export interface RepositoryCatalogSnapshot {
  /** Whether the catalog decides access yet. False is the bridge. */
  readonly activated: boolean;
  /** `provider:owner/name`, cased down, for every enabled row. Meaningless
   *  while `activated` is false, and policy.ts is the only thing that may read
   *  it, precisely so no caller forgets that. */
  readonly enabled: ReadonlySet<string>;
  readonly entries: readonly RepositoryCatalogEntry[];
  readonly state: RepositoryCatalogState;
}

export function serializeRepositoryCatalogEntry(
  row: RepositoryCatalogRow,
): RepositoryCatalogEntry {
  return {
    id: row.id,
    provider: row.provider === "gitlab" ? "gitlab" : "github",
    path: row.path,
    displayName: row.displayName,
    defaultBranch: row.defaultBranch,
    description: row.description,
    rules: row.rules,
    relationships: (row.relationships ?? []) as RepositoryRelationship[],
    enabled: row.enabled,
    source: row.source as RepositoryCatalogSource,
    profileVersion: row.currentProfileVersion,
    checksVersion: row.currentChecksVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function loadRepositoryCatalogSnapshot(): Promise<RepositoryCatalogSnapshot> {
  const [stateRow, rows] = await Promise.all([
    getConnectedRepositoryCatalogStateRow(),
    listConnectedRepositoryCatalogRows(),
  ]);
  const entries = rows.map(serializeRepositoryCatalogEntry);
  const enabled = new Set(
    entries.filter((entry) => entry.enabled).map((entry) => repositoryCatalogKey(entry)),
  );
  return {
    activated: stateRow.activated,
    enabled,
    entries,
    state: {
      activated: stateRow.activated,
      // Derived here, once, rather than by each surface that shows the banner.
      bridge: !stateRow.activated,
      activatedAt: stateRow.activatedAt?.toISOString() ?? null,
      activatedById: stateRow.activatedById,
      activatedByLabel: stateRow.activatedByLabel,
    },
  };
}
