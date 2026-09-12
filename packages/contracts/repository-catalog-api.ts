/**
 * The HTTP surface of the repository catalog: one schema per body the worker
 * accepts, and one interface per body it answers with.
 *
 * Requests are schemas because the handler refuses on them; responses are
 * interfaces because nothing validates what this worker itself produced. The
 * split matches every other dashboard contract in this package.
 */
import { z } from "zod";
import type { RepositoryProviderStatus } from "./api";
import {
  repositoryCatalogPathSchema,
  repositoryCatalogProviderSchema,
  repositoryProfileScriptGroupsSchema,
  repositoryRelationshipSchema,
  type RepositoryCatalogEntry,
  type RepositoryCatalogProvider,
  type RepositoryCatalogState,
  type RepositoryProfileVersion,
  type RepositorySuggestionDroppedGroup,
  type RepositorySuggestionProposal,
  type RepositorySuggestionUsage,
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

/**
 * Listing the installation's repositories for the import screen.
 *
 * A POST with an empty body rather than a GET, because it is the first half of
 * a two-step write: the keys the admin ticks here are the keys the commit
 * below is checked against, and pairing the two as POSTs keeps them from
 * drifting into a cached GET that answers with a list the commit no longer
 * accepts.
 */
export const repositoryCatalogImportPreviewRequestSchema = z.object({}).strict();
export type RepositoryCatalogImportPreviewRequest = z.infer<
  typeof repositoryCatalogImportPreviewRequestSchema
>;

/**
 * One repository the installation exposes, and whether the catalog already
 * holds it.
 *
 * `key` is the catalog key (`provider:owner/name`, cased down) and is what the
 * commit takes back; `path` keeps the provider's own casing, which is what the
 * row stores. Both travel because a screen that sent the display casing back
 * would import a second row for a repository the catalog already has under a
 * different spelling.
 */
export interface RepositoryCatalogImportCandidate {
  key: string;
  provider: RepositoryCatalogProvider;
  path: string;
  name: string;
  owner: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  inCatalog: boolean;
}

export interface RepositoryCatalogImportPreviewResponse {
  repositories: RepositoryCatalogImportCandidate[];
  /** One status per supported provider, as the repository picker reports them:
   *  a provider nobody connected and a provider whose listing failed are
   *  different answers and neither empties the screen. */
  providers: RepositoryProviderStatus[];
}

/**
 * Committing an import.
 *
 * `enabled` is one decision for the whole selection rather than a flag per
 * repository: the screen asks "add these, and may the agent touch them?" once,
 * and a per-row switch here would be a second, quieter way to grant access
 * beside the enabled route that is audited.
 */
export const repositoryCatalogImportRequestSchema = z
  .object({
    repositoryKeys: z.array(z.string().min(1)).min(1).max(500),
    enabled: z.boolean().default(false),
  })
  .strict();
export type RepositoryCatalogImportRequest = z.infer<
  typeof repositoryCatalogImportRequestSchema
>;

export interface RepositoryCatalogImportResponse {
  /** Rows the insert actually created. A key already in the catalog counts
   *  zero: the insert does nothing on conflict, so importing twice is not an
   *  error and does not re-enable a repository somebody switched off. */
  imported: number;
  /**
   * Keys a SUCCESSFUL listing of every provider did not contain.
   *
   * Exactly one meaning: the installation does not expose that repository any
   * more. A provider that could not be listed at all never lands here, because
   * "we could not ask" and "it is not there" are different facts and the whole
   * call is refused rather than reporting the first as the second.
   */
  skipped: string[];
  /**
   * Keys the catalog already held, so nothing was created for them.
   *
   * Separate from `skipped` because an admin reads the two differently: a key
   * that was already there is a no-op worth confirming, and a key the provider
   * no longer exposes is a stale screen worth reloading. Folding them together
   * is how an import reports "8 of 10 added" and leaves nobody able to say
   * which two, or why.
   */
  alreadyPresent: string[];
  repositories: RepositoryCatalogEntry[];
}

/**
 * Asking for a suggestion for one repository.
 *
 * The id is on the body rather than in the path because this route is one
 * call, not a sub-resource of the repository: nothing is written to the
 * repository by it, and a POST to `.../repository-catalog/suggest` says that
 * more honestly than a POST to the repository itself would.
 */
export const repositoryCatalogSuggestRequestSchema = z
  .object({ repositoryId: z.number().int().positive() })
  .strict();
export type RepositoryCatalogSuggestRequest = z.infer<
  typeof repositoryCatalogSuggestRequestSchema
>;

export interface RepositoryCatalogSuggestResponse {
  /** What the model proposed. Nothing is stored on the profile until the admin
   *  saves it through the upsert route. */
  proposal: RepositorySuggestionProposal;
  /**
   * Groups the model proposed that the service refused, with the reason.
   *
   * Returned rather than dropped in silence. An admin looking at a proposal
   * with no `test` group has to be able to tell "this repository declares no
   * tests" from "the model proposed one and it was refused", and a screen that
   * cannot tell them apart is a screen that teaches people the suggestion is
   * unreliable. Empty on the ordinary answer.
   */
  droppedGroups: RepositorySuggestionDroppedGroup[];
  /** The model that answered, as recorded, so the screen and the cost page
   *  name the same thing. */
  model: string;
  usage: RepositorySuggestionUsage | null;
  /** Null here always: tokens are recorded and priced by the cost page, the
   *  way the call_llm block leaves them. The field exists so a later stage can
   *  fill it without changing this shape. */
  costUsd: number | null;
}

/**
 * What a refused suggestion answers with when the repository has had too many
 * of them too recently.
 *
 * A body rather than a bare status because the screen has something useful to
 * say: the cap is per repository and it lifts on its own, so the one thing an
 * admin needs is when. `retryAfterSeconds` is also sent as the `Retry-After`
 * header, for the clients that read it there.
 *
 * No suggestion row is written for a refusal: nothing was asked of the
 * provider and nothing was spent, and a history filling up with refusals would
 * bury the calls that actually cost money.
 */
export interface RepositoryCatalogSuggestRateLimited {
  error: "suggestion_rate_limited";
  retryAfterSeconds: number;
}
