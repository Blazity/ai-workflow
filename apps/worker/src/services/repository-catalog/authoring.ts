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
  invalidRepositoryScriptGroupNames,
  relatesToItself,
  REPOSITORY_CATALOG_NO_ENABLED_MESSAGE,
  REPOSITORY_ENABLED_NOT_A_PROFILE_FIELD,
  REPOSITORY_SCRIPT_GROUP_NAME_MESSAGE,
  REPOSITORY_SUGGESTION_PAGE_SIZE,
  repositoryProfileRemoteExecutionWarnings,
  selfRelationshipMessage,
  type RepositoryCatalogActivateResponse,
  type RepositoryCatalogClaimedRepository,
  type RepositoryCatalogEntryResponse,
  type RepositoryCatalogListResponse,
  type RepositoryCatalogMutationResponse,
  type RepositoryCatalogSuggestionsResponse,
  type RepositoryCatalogUpsertRequest,
  type RepositorySuggestionOutcome,
  type RepositorySuggestionRecord,
} from "@shared/contracts";
import {
  activateConnectedRepositoryCatalog,
  getConnectedRepositoryCatalogRow,
  getConnectedRepositoryCatalogRowByPath,
  getConnectedRepositoryProfileVersionRow,
  listConnectedClaimedRepositoriesNotEnabled,
  setConnectedRepositoryEnabled,
  upsertConnectedRepositoryProfile,
} from "../../db/repositories/repository-catalog.js";
import {
  decodeRepositorySuggestionCursor,
  listConnectedRepositorySuggestionsPage,
} from "../../db/repositories/repository-suggestions.js";
import { getConnectedDashboardUserLabel, type DashboardRole } from "../auth/index.js";
import { loadRepositoryCatalogEntries, serializeRepositoryCatalogEntry } from "./store.js";
import { serializeRepositoryProfileVersion } from "./versions.js";

/** Who is acting, as the profile version records them. */
export interface RepositoryCatalogActor {
  role: DashboardRole;
  id: string;
}

/** The one role check the catalog has. Exported so the import and the
 *  suggestion enforce the same predicate as the profile save rather than each
 *  deciding for itself what an admin is. */
export function requireCatalogManager(actor: RepositoryCatalogActor): void {
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
  // The full rows, not the dispatch snapshot: this is the screen that renders
  // descriptions, rules and relationships, and it is the only caller that needs
  // them.
  const { state, entries } = await loadRepositoryCatalogEntries();
  return { state, repositories: entries };
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
  // The one thing checked about the scripts entry before it is stored raw.
  // The engine's schema normalizes as it parses and this deliberately does not
  // repeat it, but a group name the engine cannot resolve is not a difference
  // of dialect: it saves, and then the repository's checks silently never run,
  // which is the failure nobody goes looking for. Refused here rather than
  // repaired, because "Unit Tests" could mean `unit-tests` or `test` and only
  // the person typing it knows which.
  const badGroupNames = invalidRepositoryScriptGroupNames(input.request.scriptGroups);
  if (badGroupNames.length > 0) {
    throw new DashboardAuthError(
      400,
      `invalid_script_group_name: ${badGroupNames.join(", ")} (${REPOSITORY_SCRIPT_GROUP_NAME_MESSAGE})`,
    );
  }
  // The one relationship rule the schema cannot apply: identity is the provider
  // and path on the body, so the id a relationship would point at is not on the
  // body at all. Refused rather than dropped, because only the person editing
  // knows which other repository they meant.
  if (relatesToItself(input.expectedId ?? 0, input.request.relationships)) {
    throw new DashboardAuthError(
      400,
      selfRelationshipMessage(input.expectedId ?? 0),
    );
  }
  if (input.expectedId !== undefined && input.expectedId !== 0) {
    const existing = await getConnectedRepositoryCatalogRowByPath({
      provider: input.request.provider,
      path: input.request.path,
    });
    if (!existing || existing.id !== input.expectedId) {
      throw new DashboardAuthError(409, "repository_mismatch");
    }
    // A grant is never a profile field. It used to be accepted here and
    // discarded, which reads on the wire exactly like a grant that landed.
    // Only a value that would MOVE the switch is refused: repeating where the
    // switch already stands changes nothing, and callers were told for a long
    // time that this field was ignored here.
    if (input.request.enabled !== undefined && input.request.enabled !== existing.enabled) {
      throw new DashboardAuthError(400, REPOSITORY_ENABLED_NOT_A_PROFILE_FIELD);
    }
  } else if (input.request.enabled !== undefined) {
    // A "create" the route reconciles into an edit, because the provider and
    // path are already in the catalog. Same rule: the row exists, so this
    // `enabled` would be discarded exactly as the one above would, and it is
    // refused on the same condition.
    const existing = await getConnectedRepositoryCatalogRowByPath({
      provider: input.request.provider,
      path: input.request.path,
    });
    if (existing && input.request.enabled !== existing.enabled) {
      throw new DashboardAuthError(400, REPOSITORY_ENABLED_NOT_A_PROFILE_FIELD);
    }
  }
  // Every optional field is forwarded ONLY when the request carried it. The
  // schema applies no defaults any more, so an absent field stays absent and
  // the statement carries the stored value forward; spreading the field in
  // unconditionally would put an explicit `undefined` where the repository tier
  // reads "absent" and "null" apart.
  const write = {
    provider: input.request.provider,
    path: input.request.path,
    ...(input.request.displayName === undefined
      ? {}
      : { displayName: input.request.displayName }),
    ...(input.request.defaultBranch === undefined
      ? {}
      : { defaultBranch: input.request.defaultBranch }),
    ...(input.request.description === undefined
      ? {}
      : { description: input.request.description }),
    ...(input.request.rules === undefined ? {} : { rules: input.request.rules }),
    ...(input.request.relationships === undefined
      ? {}
      : { relationships: input.request.relationships }),
    ...(input.request.scriptGroups === undefined
      ? {}
      : { scriptGroups: input.request.scriptGroups }),
    ...(input.request.gateGroups === undefined
      ? {}
      : { gateGroups: input.request.gateGroups }),
    ...(input.request.batchTimeoutMinutes === undefined
      ? {}
      : { batchTimeoutMinutes: input.request.batchTimeoutMinutes }),
    actorId: input.actor.id,
    actorLabel: await getConnectedDashboardUserLabel(input.actor.id),
    reason: input.request.reason,
    // A profile save is not a grant. Creating a repository here leaves it
    // switched off unless this request said otherwise, and says nothing at all
    // about a repository that already exists.
    enabled: input.request.enabled ?? false,
  };
  // Two calls rather than one, because a request WITHOUT the token cannot come
  // back a conflict and the repository tier says so in its overloads. The
  // branch is what keeps that honest at the call site.
  const saved =
    input.request.expectedProfileVersion === undefined
      ? await upsertConnectedRepositoryProfile(write)
      : await upsertConnectedRepositoryProfile({
          ...write,
          expectedProfileVersion: input.request.expectedProfileVersion,
        });
  if ("conflict" in saved) {
    throw new RepositoryProfileConflictError(saved.currentVersion);
  }
  const row = await requireRow(saved.id);
  return {
    repository: serializeRepositoryCatalogEntry(row),
    version: saved.version,
    // Both fields, and what they mean together, are declared on
    // RepositoryCatalogMutationResponse in @shared/contracts. This maps the
    // repository tier's spelling onto the wire's and says nothing of its own.
    unchanged: !saved.minted,
    changedFields: saved.changedFields,
    // Read off the entry this request carried, not off the stored profile: a
    // save that did not touch the scripts warns about nothing, which is what
    // keeps the warning attached to something the operator just typed. Never a
    // refusal -- see the field's declaration.
    warnings: repositoryProfileRemoteExecutionWarnings(input.request.scriptGroups),
  };
}

/**
 * The save was refused because the profile moved under the caller.
 *
 * Its own error rather than a `DashboardAuthError`, because the route answers
 * it with a BODY (the version to reload), the way a stale pre-PR checks save is
 * answered. A bare status would leave the screen having to guess whether to
 * reload or to retry.
 */
export class RepositoryProfileConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super("repository_profile_conflict");
    this.name = "RepositoryProfileConflictError";
  }
}

/**
 * One page of a repository's suggestion calls, newest first.
 *
 * A read, so every role may make it: what this deployment spent asking a model
 * about its own repositories is not a privilege, and a member who cannot see it
 * cannot tell a repository the model keeps failing on from one nobody has asked
 * about.
 */
export async function readRepositorySuggestions(input: {
  id: number;
  cursor?: string | null;
}): Promise<RepositoryCatalogSuggestionsResponse> {
  await requireRow(input.id);
  const cursor =
    input.cursor === undefined || input.cursor === null || input.cursor.length === 0
      ? null
      : decodeRepositorySuggestionCursor(input.cursor);
  if (input.cursor && cursor === null) {
    throw new DashboardAuthError(400, "invalid_cursor");
  }
  const page = await listConnectedRepositorySuggestionsPage({
    repositoryId: input.id,
    limit: REPOSITORY_SUGGESTION_PAGE_SIZE,
    cursor,
  });
  return {
    suggestions: page.rows.map(
      (row): RepositorySuggestionRecord => ({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        outcome: row.outcome as RepositorySuggestionOutcome,
        model: row.model,
        actorLabel: row.actorLabel,
        tokensInput: row.tokensInput,
        tokensOutput: row.tokensOutput,
        durationMs: row.durationMs,
        // Unpriced, never zero: the provider reported nothing, which is what a
        // timeout and a repository missing at the provider both look like.
        priced: row.tokensInput !== null || row.tokensOutput !== null,
      }),
    ),
    nextCursor: page.nextCursor,
  };
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
  // Read AFTER the write, and counted here rather than on each surface: the
  // number that matters after a flip is not this row's flag but how many rows
  // are left enabled, because taking it to zero on an activated catalog stops
  // dispatch selecting anything at all. Both surfaces report the same number
  // because both get it from here.
  const { entries } = await loadRepositoryCatalogEntries();
  return {
    repository: serializeRepositoryCatalogEntry(row),
    enabledRemaining: entries.filter((entry) => entry.enabled).length,
  };
}

/**
 * Activation refused because the catalog enables nothing.
 *
 * Here rather than on the two surfaces that used to say it: the dashboard
 * dialog hid the button and the MCP tool raised its own copy of the sentence,
 * and the route both of them go through checked neither, so a POST straight to
 * `/api/v1/repository-catalog/activate` activated a catalog that then refused
 * every dispatch. Its own error rather than a `DashboardAuthError`, because the
 * route answers it with a BODY carrying a stable code, the way a stale profile
 * save is answered.
 */
export class RepositoryCatalogNoEnabledError extends Error {
  constructor() {
    super(REPOSITORY_CATALOG_NO_ENABLED_MESSAGE);
    this.name = "RepositoryCatalogNoEnabledError";
  }
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
  /** Why the bridge is ending, recorded on the state row. The route refuses an
   *  empty one, so this is never blank on the path an operator takes. */
  reason: string;
}): Promise<RepositoryCatalogActivateOutcome> {
  requireCatalogManager(input.actor);
  // Before the acknowledgement check and before anything is written: a catalog
  // with nothing enabled is the one case where confirming is never the right
  // answer, whichever surface asked, and the repair (enable a row) is one click
  // away on the same screen.
  const { entries } = await loadRepositoryCatalogEntries();
  if (!entries.some((entry) => entry.enabled)) {
    throw new RepositoryCatalogNoEnabledError();
  }
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
    reason: input.reason,
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
        activationReason: state.activationReason,
      },
    },
  };
}
