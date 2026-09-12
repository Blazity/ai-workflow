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
  type RepositoryProfileWarning,
  type RepositoryRelationship,
  type RepositorySuggestionDroppedGroup,
  type RepositorySuggestionProposal,
  type RepositorySuggestionRecord,
  type RepositorySuggestionUsage,
} from "./repository-catalog";

export const REPOSITORY_CATALOG_REASON_MAX_LENGTH = 500;

/**
 * Why activating the catalog is refused while nothing is enabled.
 *
 * One sentence, in one place. It used to be typed out in the dashboard dialog
 * and again in the MCP tool, with the service that both go through checking
 * neither, so an activation that reached the route directly went through. The
 * check lives in `activateRepositoryCatalog` now and this is the sentence it
 * refuses with, which is why both surfaces can show it without owning a copy.
 */
export const REPOSITORY_CATALOG_NO_ENABLED_MESSAGE =
  "no repository in this catalog is enabled, so activating would stop dispatch selecting every repository at once; enable at least one first";

/** The 409 body that refusal takes on the HTTP surface, shaped like
 *  `RepositoryCatalogProfileConflict`: a stable `error` code a screen can branch
 *  on, plus the sentence it shows. */
export interface RepositoryCatalogActivateBlocked {
  error: "no_enabled_repository";
  message: string;
}

/** The most repositories one profile may relate itself to. A relationship list
 *  is read by a person on the Overview tab; past this it is a data dump nobody
 *  reads and a payload every save carries. */
export const REPOSITORY_RELATIONSHIPS_MAX = 50;

/**
 * The relationships a profile save may carry.
 *
 * Refused rather than repaired, and refused HERE rather than on one surface:
 * a self-reference, the same repository twice and an unbounded list are all
 * shapes the Overview tab cannot render usefully, and the dashboard, the HTTP
 * route and the MCP tool all parse this same schema. An unknown repository id
 * is deliberately still accepted: the row it names may be imported later, and
 * the tab renders it as `repository <id>` rather than crashing.
 */
export const repositoryProfileRelationshipsSchema = z
  .array(repositoryRelationshipSchema)
  .max(
    REPOSITORY_RELATIONSHIPS_MAX,
    `at most ${REPOSITORY_RELATIONSHIPS_MAX} relationships`,
  )
  .superRefine((relationships, ctx) => {
    const seen = new Set<number>();
    for (const [index, relationship] of relationships.entries()) {
      if (!seen.has(relationship.repositoryId)) {
        seen.add(relationship.repositoryId);
        continue;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "repositoryId"],
        message: `repository ${relationship.repositoryId} is related twice; one relationship per repository`,
      });
    }
  });

/** The message a save that relates a repository to itself is refused with. The
 *  id is not on the body (identity is the provider and path), so this is the one
 *  relationship rule the schema cannot apply and the service does. */
export function selfRelationshipMessage(repositoryId: number): string {
  return `relationship_self_reference: repository ${repositoryId} cannot be related to itself`;
}

/** True when the list relates the repository to itself. */
export function relatesToItself(
  repositoryId: number,
  relationships: readonly RepositoryRelationship[] | undefined,
): boolean {
  if (repositoryId <= 0 || relationships === undefined) return false;
  return relationships.some(
    (relationship) => relationship.repositoryId === repositoryId,
  );
}

/**
 * The message an upsert is refused with when it carries an `enabled` for a
 * repository that already exists AND that value differs from the switch's
 * current position.
 *
 * Accepting and discarding it taught callers that the field was a second,
 * quieter way to grant access, so a save that would MOVE the switch is refused
 * rather than silently ignored. A save that merely repeats where the switch
 * already stands is not refused: callers were told for a long time that the
 * field was ignored here, and failing an idempotent payload would break a
 * caller that changes nothing.
 */
export const REPOSITORY_ENABLED_NOT_A_PROFILE_FIELD =
  "enabled is not a profile field and this save would change it; use the switch on the Repositories list or repositories.set_enabled";

/** The longest whole-run checks ceiling a repository profile may ask for, in
 *  minutes. Below the engine's own 180 minute bound on the same value, because
 *  a repository is one of several sharing the run's ceiling and this is a
 *  screen's field rather than a deployment's last resort. */
export const REPOSITORY_BATCH_TIMEOUT_MAX_MINUTES = 120;

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

/** How many profile versions one page of the history carries, and the most one
 *  page may ask for. The same two numbers the MCP `repositories.list_versions`
 *  tool pages by, imported there rather than typed again: a History tab and an
 *  agent reading the same history must not disagree about where a page ends. */
export const REPOSITORY_VERSION_PAGE_DEFAULT = 50;
export const REPOSITORY_VERSION_PAGE_MAX = 200;

/**
 * How the versions route is paged.
 *
 * `before` takes a version number and means "older than this", exactly as the
 * MCP tool's cursor does: rows are only ever appended, and a version number is
 * a cursor that cannot shift under a reader the way an offset would.
 */
export const repositoryCatalogVersionsQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(REPOSITORY_VERSION_PAGE_MAX)
      .optional(),
    before: z.coerce.number().int().positive().optional(),
  })
  .strict();
export type RepositoryCatalogVersionsQuery = z.infer<
  typeof repositoryCatalogVersionsQuerySchema
>;

export interface RepositoryCatalogVersionsResponse {
  versions: RepositoryProfileVersion[];
  /** Whether versions older than the last one on this page exist. The same
   *  field name the MCP tool answers with, so one History tab and one agent
   *  read the same envelope. */
  hasMore: boolean;
}

export interface RepositoryCatalogMutationResponse {
  repository: RepositoryCatalogEntry;
  /** The profile version this write created. Absent for a write that changed
   *  only the enabled flag, which is not a profile change and mints no
   *  version: a run in flight must not see its checks configuration move
   *  because somebody toggled a switch. */
  version?: number;
  /**
   * True when the request asked for nothing the stored profile does not
   * already say, so no version was minted and `version` is the one that was
   * already current.
   *
   * Said out loud rather than left for the caller to infer from a version
   * number that did not move. The history is what an operator reads to find
   * out what changed and when, and a row per save that changed nothing turns
   * it into a log of clicks; a caller that retries a save it is unsure landed
   * has to be able to tell "already done" from "done again".
   */
  unchanged?: boolean;
  /**
   * Which profile fields this write actually moved, in `REPOSITORY_PROFILE_FIELDS`
   * order.
   *
   * Empty whenever `unchanged` is true, and ALSO empty in one case where it is
   * false: a request that created a repository whose first profile sets none of
   * these fields still mints version 1, because the repository is new, but it
   * moved no field. So "empty" means "no field to name", never "nothing
   * happened"; `unchanged` is the field that answers that.
   */
  changedFields?: RepositoryProfileField[];
  /**
   * How many repositories the catalog enables after this write.
   *
   * Answered by the enabled route only, which is the only write that can move
   * it, and the same number `repositories.set_enabled` reports through MCP. A
   * screen needs it because taking it to zero on an activated catalog halts
   * every next run, and a row that reads "not enabled" says nothing about the
   * other ninety.
   */
  enabledRemaining?: number;
  /**
   * Commands this save stored that the suggestion path would have dropped.
   *
   * Empty on the ordinary save, and never a refusal: the profile route is
   * deliberately permissive, because the documented uv preset is exactly the
   * shape the matcher flags. It is returned so the Scripts tab can say so
   * beside the command, rather than leaving an operator to discover that the
   * suggestion filter and the save disagree.
   */
  warnings?: RepositoryProfileWarning[];
}

/** A profile field an upsert can move. The names are the request's own, so a
 *  caller reading `changedFields` back can map each one to the field it sent. */
export const REPOSITORY_PROFILE_FIELDS = [
  "description",
  "rules",
  "relationships",
  "scriptGroups",
  "gateGroups",
  "batchTimeoutMinutes",
] as const;
export type RepositoryProfileField = (typeof REPOSITORY_PROFILE_FIELDS)[number];

/**
 * Saving a repository profile.
 *
 * `provider` and `path` are on the body rather than only in the route, because
 * this same shape creates a row that does not exist yet. A route id of 0 is
 * how the dashboard says "new"; the pair decides identity either way.
 *
 * **Every profile field is optional and omitted means UNCHANGED.** No field
 * carries a schema default any more, because a default made "omitted" and
 * "set it to empty" the same request: a screen saving the Rules tab had to
 * resend the script groups it was not looking at, and any caller that forgot
 * one erased it. Absent is `undefined` all the way to the statement, which
 * carries the stored value forward; an explicit `null` on a nullable field is
 * how a caller says "clear this".
 */
export const repositoryCatalogUpsertRequestSchema = z
  .object({
    provider: repositoryCatalogProviderSchema,
    path: repositoryCatalogPathSchema,
    displayName: z.string().max(200).optional(),
    defaultBranch: z.string().max(200).optional(),
    description: z.string().max(20_000).optional(),
    rules: z.string().max(20_000).optional(),
    relationships: repositoryProfileRelationshipsSchema.optional(),
    /** The repository scripts entry for this repository, stored verbatim.
     *  Explicit null clears it ("no checks apply"); omitted leaves it alone. */
    scriptGroups: repositoryProfileScriptGroupsSchema.optional(),
    gateGroups: z.array(z.string()).nullable().optional(),
    /** The whole-run checks ceiling this repository asks for. Null clears it
     *  back to the operator ceiling; omitted leaves it alone. */
    batchTimeoutMinutes: z
      .number()
      .int()
      .min(1)
      .max(REPOSITORY_BATCH_TIMEOUT_MAX_MINUTES)
      .nullable()
      .optional(),
    /**
     * Whether a repository this call CREATES may be touched by the agent.
     *
     * Omitted means false, and it is REFUSED for a repository that already
     * exists (`REPOSITORY_ENABLED_NOT_A_PROFILE_FIELD`) rather than accepted
     * and discarded, which is what it used to be: a field that looks like it
     * grants access and silently does not is worse than one that is not there.
     * Writing a profile says what to run in a repository; it never says the
     * agent may enter one. Granting is the enabled route, which is a separate
     * click and a separate audit line.
     */
    enabled: z.boolean().optional(),
    /**
     * Why this version was minted, shown on the History tab.
     *
     * Required, and trimmed, exactly as the MCP tool requires it. It carried
     * `.default("")` until stage F: a save that reached this route without one
     * minted a version attributed to nobody, and the History tab then read
     * "No reason recorded" for a change somebody made on purpose.
     */
    reason: z
      .string()
      .trim()
      .min(1, "a reason is required")
      .max(REPOSITORY_CATALOG_REASON_MAX_LENGTH),
    /**
     * The profile version the caller loaded, as a concurrency token.
     *
     * When it is present and is not the version the repository currently
     * resolves to, the save is refused with 409 and
     * `RepositoryCatalogProfileConflict`, exactly as `PrePrCheckSaveRequest`'s
     * `baseVersion` is refused (api.ts). It replaces the pre-flight GET a
     * screen used to make: a read followed by a write leaves a window open
     * between them, and a predicate the write itself carries does not.
     *
     * Optional, and absent means the save proceeds unconditionally, which is
     * what a client written before this field existed sends. 0 is the token for
     * "this repository had no profile when I loaded it".
     */
    expectedProfileVersion: z.number().int().nonnegative().optional(),
  })
  .strict();
export type RepositoryCatalogUpsertRequest = z.infer<
  typeof repositoryCatalogUpsertRequestSchema
>;

/** The 409 body a stale `expectedProfileVersion` is refused with.
 *  `currentVersion` is what the caller has to reload before saving again. */
export interface RepositoryCatalogProfileConflict {
  error: "repository_profile_conflict";
  currentVersion: number;
}

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
    /**
     * Why the bridge is ending, recorded on the state row.
     *
     * Required, not optional. Activation is irreversible from any screen and
     * stops dispatch selecting repositories somebody may be working in, so the
     * pause is the point; a reason that is collected and dropped teaches an
     * operator that the box is decoration, which is what the dialog did before
     * this field existed.
     */
    reason: z
      .string()
      .trim()
      .min(1, "a reason is required")
      .max(REPOSITORY_CATALOG_REASON_MAX_LENGTH),
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

/** What the `skipped` bucket means, in the words the import dialog shows. One
 *  constant, because the response's own description and the screen that renders
 *  it are the same claim and drifted apart once already. */
export const REPOSITORY_IMPORT_SKIPPED_NOTE =
  "not in this installation's listing (removed, or not visible to the configured token)";

export interface RepositoryCatalogImportResponse {
  /** Rows the insert actually created. A key already in the catalog counts
   *  zero: the insert does nothing on conflict, so importing twice is not an
   *  error and does not re-enable a repository somebody switched off. */
  imported: number;
  /**
   * Keys a SUCCESSFUL listing of every provider did not contain: **not in this
   * installation's listing (removed, or not visible to the configured token)**.
   *
   * Two causes, one bucket, and the copy says both. The listing cannot tell
   * them apart -- a repository deleted at the provider and one the configured
   * token cannot see are the same absence -- and a screen that claimed only the
   * first sent operators looking for a deletion that never happened. A provider
   * that could not be listed at all never lands here, because "we could not
   * ask" and "it is not there" are different facts and the whole call is
   * refused rather than reporting the first as the second.
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

/** How many suggestion rows one page of the history carries. The history sits
 *  under a repository's profile versions on one tab, so the page is the size of
 *  a screen rather than of a table. */
export const REPOSITORY_SUGGESTION_PAGE_SIZE = 50;

/**
 * A repository's suggestion calls, newest first.
 *
 * Open to every role, like the rest of the catalog's reads: what a deployment
 * spent asking a model about its own repositories is not a privilege, and an
 * admin is not the only person who has to be able to tell a repository the
 * model keeps failing on from one nobody has asked about.
 *
 * Paginated by cursor rather than by offset, because rows are only ever
 * appended: an offset page would shift under a call made while somebody reads
 * the history, and the one thing a cost history must not do is show a row twice
 * or skip one.
 */
export interface RepositoryCatalogSuggestionsResponse {
  suggestions: RepositorySuggestionRecord[];
  /** Opaque; hand it back as `cursor` for the next page. Null on the last
   *  page. */
  nextCursor: string | null;
}
