/**
 * What a dashboard actor may do to the catalog, and what each outcome means.
 *
 * The route above turns these outcomes into status codes and nothing else; the
 * role check lives here so the MCP surface a later stage adds cannot reach the
 * tables past it.
 */
import {
  canManageRepositoryCatalog,
  DashboardAuthError,
  type RepositoryCatalogActivateResponse,
  type RepositoryCatalogClaimedRepository,
  type RepositoryCatalogEntryResponse,
  type RepositoryCatalogListResponse,
  type RepositoryCatalogMutationResponse,
  type RepositoryCatalogUpsertRequest,
  type RepositoryCatalogVersionsResponse,
} from "@shared/contracts";
import {
  activateConnectedRepositoryCatalog,
  getConnectedRepositoryCatalogRow,
  getConnectedRepositoryCatalogRowByPath,
  getConnectedRepositoryProfileVersionRow,
  listConnectedClaimedRepositoriesNotEnabled,
  listConnectedRepositoryProfileVersionRows,
  setConnectedRepositoryEnabled,
  upsertConnectedRepositoryProfile,
} from "../../db/repositories/repository-catalog.js";
import { getConnectedDashboardUserLabel, type DashboardRole } from "../auth/index.js";
import { loadRepositoryCatalogSnapshot, serializeRepositoryCatalogEntry } from "./store.js";
import { serializeRepositoryProfileVersion } from "./versions.js";

/** Who is acting, as the profile version records them. */
export interface RepositoryCatalogActor {
  role: DashboardRole;
  id: string;
}

function requireCatalogManager(actor: RepositoryCatalogActor): void {
  if (!canManageRepositoryCatalog(actor.role)) {
    throw new DashboardAuthError(403, "Forbidden");
  }
}

async function requireRow(id: number) {
  const row = await getConnectedRepositoryCatalogRow(id);
  if (!row) throw new DashboardAuthError(404, "Unknown repository");
  return row;
}

/** Reads are open to every role: knowing which repositories exist is not a
 *  privilege, and a member who cannot see the list cannot read a run either. */
export async function readRepositoryCatalog(): Promise<RepositoryCatalogListResponse> {
  const snapshot = await loadRepositoryCatalogSnapshot();
  return { state: snapshot.state, repositories: [...snapshot.entries] };
}

export async function readRepositoryCatalogEntry(
  id: number,
): Promise<RepositoryCatalogEntryResponse> {
  const row = await requireRow(id);
  // Keyed, not "list a page and hope the one we want is on it": the row already
  // says which version it resolves to, so ask for that version.
  const current =
    row.currentProfileVersion > 0
      ? await getConnectedRepositoryProfileVersionRow(id, row.currentProfileVersion)
      : null;
  return {
    repository: serializeRepositoryCatalogEntry(row),
    currentProfile: current ? serializeRepositoryProfileVersion(current) : null,
  };
}

export async function readRepositoryCatalogVersions(
  id: number,
): Promise<RepositoryCatalogVersionsResponse> {
  await requireRow(id);
  const rows = await listConnectedRepositoryProfileVersionRows(id);
  return { versions: rows.map(serializeRepositoryProfileVersion) };
}

export async function saveRepositoryProfile(input: {
  actor: RepositoryCatalogActor;
  request: RepositoryCatalogUpsertRequest;
  /**
   * The repository the caller believes it is editing, or 0 for "one the
   * catalog has never seen".
   *
   * Identity is the provider and path on the request, because the same call
   * creates a row that does not exist yet. This is the guard against a screen
   * left open on one repository writing a profile onto another because the
   * body was edited underneath it, and it is refused rather than reconciled:
   * only the person looking at the screen knows which of the two they meant.
   */
  expectedId?: number;
}): Promise<RepositoryCatalogMutationResponse> {
  requireCatalogManager(input.actor);
  if (input.expectedId !== undefined && input.expectedId !== 0) {
    const existing = await getConnectedRepositoryCatalogRowByPath({
      provider: input.request.provider,
      path: input.request.path,
    });
    if (!existing || existing.id !== input.expectedId) {
      throw new DashboardAuthError(409, "repository_mismatch");
    }
  }
  const saved = await upsertConnectedRepositoryProfile({
    provider: input.request.provider,
    path: input.request.path,
    ...(input.request.displayName === undefined
      ? {}
      : { displayName: input.request.displayName }),
    ...(input.request.defaultBranch === undefined
      ? {}
      : { defaultBranch: input.request.defaultBranch }),
    description: input.request.description,
    rules: input.request.rules,
    relationships: input.request.relationships,
    scriptGroups: input.request.scriptGroups,
    gateGroups: input.request.gateGroups,
    actorId: input.actor.id,
    actorLabel: await getConnectedDashboardUserLabel(input.actor.id),
    reason: input.request.reason,
    // A profile save is not a grant. Creating a repository here leaves it
    // switched off unless this request said otherwise, and says nothing at all
    // about a repository that already exists.
    enabled: input.request.enabled ?? false,
  });
  const row = await requireRow(saved.id);
  return { repository: serializeRepositoryCatalogEntry(row), version: saved.version };
}

export async function setRepositoryCatalogEnabled(input: {
  actor: RepositoryCatalogActor;
  id: number;
  enabled: boolean;
}): Promise<RepositoryCatalogMutationResponse> {
  requireCatalogManager(input.actor);
  await requireRow(input.id);
  const row = await setConnectedRepositoryEnabled({ id: input.id, enabled: input.enabled });
  if (!row) throw new DashboardAuthError(404, "Unknown repository");
  return { repository: serializeRepositoryCatalogEntry(row) };
}

/** Activation refused because the dialog the admin confirmed is out of date. */
export type RepositoryCatalogActivateOutcome =
  | { kind: "activated"; response: RepositoryCatalogActivateResponse }
  | { kind: "unacknowledged"; repositories: RepositoryCatalogClaimedRepository[] };

/**
 * End the bridge, but only against the list the admin was actually shown.
 *
 * Activation is the moment dispatch stops selecting disabled repositories, and
 * the repositories it will stop selecting are exactly the ones with work in
 * flight right now. Requiring the request to echo those keys back is what makes
 * a stale dialog a refusal with the current list rather than a surprise the
 * next morning.
 */
export async function activateRepositoryCatalog(input: {
  actor: RepositoryCatalogActor;
  acknowledgedRepositoryKeys: string[];
}): Promise<RepositoryCatalogActivateOutcome> {
  requireCatalogManager(input.actor);
  const claimed = await listConnectedClaimedRepositoriesNotEnabled();
  const acknowledged = new Set(
    input.acknowledgedRepositoryKeys.map((key) => key.toLowerCase()),
  );
  const missing = claimed.filter((entry) => !acknowledged.has(entry.key));
  if (missing.length > 0) {
    return { kind: "unacknowledged", repositories: missing };
  }
  const state = await activateConnectedRepositoryCatalog({
    actorId: input.actor.id,
    actorLabel: await getConnectedDashboardUserLabel(input.actor.id),
  });
  return {
    kind: "activated",
    response: {
      state: {
        activated: state.activated,
        bridge: !state.activated,
        activatedAt: state.activatedAt?.toISOString() ?? null,
        activatedById: state.activatedById,
        activatedByLabel: state.activatedByLabel,
      },
    },
  };
}
