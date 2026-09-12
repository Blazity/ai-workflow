/**
 * The HTTP surface of the repository catalog: one schema per body the worker
 * accepts, and one interface per body it answers with.
 *
 * Requests are schemas because the handler refuses on them; responses are
 * interfaces because nothing validates what this worker itself produced. The
 * split matches every other dashboard contract in this package.
 */
import { z } from "zod";
import {
  repositoryCatalogPathSchema,
  repositoryCatalogProviderSchema,
  repositoryProfileScriptGroupsSchema,
  repositoryRelationshipSchema,
  type RepositoryCatalogEntry,
  type RepositoryCatalogState,
  type RepositoryProfileVersion,
} from "./repository-catalog";

export const REPOSITORY_CATALOG_REASON_MAX_LENGTH = 500;

/** Everything the Repositories list screen loads in one call. */
export interface RepositoryCatalogListResponse {
  state: RepositoryCatalogState;
  repositories: RepositoryCatalogEntry[];
}

/** One repository, with the profile the engine currently resolves for it. */
export interface RepositoryCatalogEntryResponse {
  repository: RepositoryCatalogEntry;
  currentProfile: RepositoryProfileVersion | null;
}

export interface RepositoryCatalogVersionsResponse {
  versions: RepositoryProfileVersion[];
}

export interface RepositoryCatalogMutationResponse {
  repository: RepositoryCatalogEntry;
  /** The profile version this write created. Absent for a write that changed
   *  only the enabled flag, which is not a profile change and mints no
   *  version: a run in flight must not see its checks configuration move
   *  because somebody toggled a switch. */
  version?: number;
}

/**
 * Saving a repository profile.
 *
 * `provider` and `path` are on the body rather than only in the route, because
 * this same shape creates a row that does not exist yet. A route id of 0 is
 * how the dashboard says "new"; the pair decides identity either way.
 */
export const repositoryCatalogUpsertRequestSchema = z
  .object({
    provider: repositoryCatalogProviderSchema,
    path: repositoryCatalogPathSchema,
    displayName: z.string().max(200).optional(),
    defaultBranch: z.string().max(200).optional(),
    description: z.string().max(20_000).default(""),
    rules: z.string().max(20_000).default(""),
    relationships: z.array(repositoryRelationshipSchema).default([]),
    /** The repository scripts entry for this repository, stored verbatim. */
    scriptGroups: repositoryProfileScriptGroupsSchema.default(null),
    gateGroups: z.array(z.string()).nullable().default(null),
    /**
     * Whether a repository this call CREATES may be touched by the agent.
     *
     * Omitted means false, and it is ignored for a repository that already
     * exists. Writing a profile says what to run in a repository; it never says
     * the agent may enter one. Granting is the enabled route, which is a
     * separate click and a separate audit line.
     */
    enabled: z.boolean().optional(),
    reason: z.string().max(REPOSITORY_CATALOG_REASON_MAX_LENGTH).default(""),
  })
  .strict();
export type RepositoryCatalogUpsertRequest = z.infer<
  typeof repositoryCatalogUpsertRequestSchema
>;

export const repositoryCatalogEnabledRequestSchema = z
  .object({ enabled: z.boolean({ message: "enabled must be a boolean" }) })
  .strict();
export type RepositoryCatalogEnabledRequest = z.infer<
  typeof repositoryCatalogEnabledRequestSchema
>;

/**
 * Activating the catalog.
 *
 * The body carries what the admin was shown, not merely "yes". Activation is
 * the moment dispatch stops selecting disabled repositories, and the dialog
 * names every repository that currently holds a run claim and is not enabled;
 * echoing those keys back is what proves the dialog the admin confirmed was
 * built from the same list the worker is about to act on. A stale dialog is
 * refused with the current list rather than silently obeyed.
 */
export const repositoryCatalogActivateRequestSchema = z
  .object({
    acknowledgedRepositoryKeys: z.array(z.string()).default([]),
  })
  .strict();
export type RepositoryCatalogActivateRequest = z.infer<
  typeof repositoryCatalogActivateRequestSchema
>;

export interface RepositoryCatalogActivateResponse {
  state: RepositoryCatalogState;
}

/**
 * One repository a refused activation names.
 *
 * It carries the tickets and runs it was found through, because the population
 * is honest about being approximate: no table ties a workflow-owned branch to
 * the run that created it, so this is "repositories with branches on tickets
 * that currently hold a claim". An admin has to be able to check, not just
 * trust, before ending the bridge.
 */
export interface RepositoryCatalogClaimedRepository {
  key: string;
  displayName: string;
  ticketKeys: string[];
  runIds: string[];
}

/** What a refused activation answers with: what the dialog has to show before
 *  the admin can confirm again. */
export interface RepositoryCatalogActivateConflict {
  error: "unacknowledged_repositories";
  repositories: RepositoryCatalogClaimedRepository[];
}
