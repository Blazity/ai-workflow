/**
 * The repository catalog: what the deployment knows about each repository it
 * may touch, and the versioned profile that carries its description, its rules,
 * its relationships and its script groups.
 *
 * Shared rather than worker-owned because three sides read the same shapes: the
 * worker's repository tier stores them, the worker's engine composes the check
 * configuration out of them, and the dashboard renders and edits them. A second
 * spelling of "what a profile version holds" is the one shape this must never
 * take.
 *
 * The script groups carried by a profile version are the EXISTING repository
 * entry shape (`PrePrCheckRepositoryConfig`), restricted to one repository, so
 * the migration out of the global blob is a move rather than a rewrite and the
 * engine keeps parsing exactly what it parsed before.
 */
import { z } from "zod";
import {
  REPOSITORY_SCRIPT_GROUP_NAME_MAX_LENGTH,
  REPOSITORY_SCRIPT_GROUP_NAME_PATTERN,
} from "./repository-scripts";

/**
 * How a repository entered the catalog. It is provenance, not policy: nothing
 * branches on it, and it exists so an operator opening a row that nobody
 * remembers creating can tell an allowlist import from a hand-typed entry.
 */
export const REPOSITORY_CATALOG_SOURCES = [
  "imported",
  "manual",
  "seeded",
  "migrated",
] as const;
export const repositoryCatalogSourceSchema = z.enum(REPOSITORY_CATALOG_SOURCES);
export type RepositoryCatalogSource = z.infer<typeof repositoryCatalogSourceSchema>;

export const repositoryCatalogProviderSchema = z.enum(["github", "gitlab"]);
export type RepositoryCatalogProvider = z.infer<typeof repositoryCatalogProviderSchema>;

/** Longest text a markdown field may carry. Description and rules are pasted by
 *  hand and fed to an LLM later, so the bound is generous but real: nothing on
 *  this screen is a place to store a whole document. */
export const REPOSITORY_CATALOG_MARKDOWN_MAX_LENGTH = 20_000;
export const REPOSITORY_CATALOG_LABEL_MAX_LENGTH = 200;
/** GitHub uses `owner/repo`; GitLab may nest groups, so at least one slash and
 *  no empty segment is the whole rule, exactly as the allowlist reads it. */
export const REPOSITORY_CATALOG_PATH_PATTERN = /^[^/\s]+(?:\/[^/\s]+)+$/;

export const repositoryRelationshipSchema = z
  .object({
    repositoryId: z.number().int().positive(),
    label: z.string().max(REPOSITORY_CATALOG_LABEL_MAX_LENGTH),
  })
  .strict();
export type RepositoryRelationship = z.infer<typeof repositoryRelationshipSchema>;

const markdownSchema = z.string().max(REPOSITORY_CATALOG_MARKDOWN_MAX_LENGTH);

export const repositoryCatalogPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(REPOSITORY_CATALOG_LABEL_MAX_LENGTH)
  .regex(
    REPOSITORY_CATALOG_PATH_PATTERN,
    'repository path must look like "owner/name"',
  );

export const repositoryCatalogEntrySchema = z
  .object({
    id: z.number().int().positive(),
    provider: repositoryCatalogProviderSchema,
    path: repositoryCatalogPathSchema,
    displayName: z.string().max(REPOSITORY_CATALOG_LABEL_MAX_LENGTH),
    defaultBranch: z.string().max(REPOSITORY_CATALOG_LABEL_MAX_LENGTH),
    description: markdownSchema,
    rules: markdownSchema,
    relationships: z.array(repositoryRelationshipSchema),
    enabled: z.boolean(),
    source: repositoryCatalogSourceSchema,
    /** The profile version this row currently resolves to. 0 means the row was
     *  created (by an import or the allowlist seed) and never given a profile,
     *  which is how "known but not configured" is spelled. */
    profileVersion: z.number().int().nonnegative(),
    /** The version of what this repository's CHECKS run. It moves only when
     *  the script groups or the gate group selection change, so an edit to the
     *  description or the rules leaves it alone, and with it every publication
     *  gate recorded by a run still in flight. */
    checksVersion: z.number().int().nonnegative(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type RepositoryCatalogEntry = z.infer<typeof repositoryCatalogEntrySchema>;

/**
 * The script groups a profile version carries: one entry of the repository
 * scripts configuration, for this repository alone.
 *
 * Deliberately loose (`unknown` behind a record) rather than a second copy of
 * `repoScriptsConfigSchema`. That schema lives in the engine because it
 * normalizes as it parses (legacy flat commands become a `checks` group,
 * defaults are filled), and what is stored is the RAW submitted entry, because
 * the publication gate fingerprints stored bytes. Validating it twice here
 * would either duplicate the engine's refusal messages or quietly change what
 * gets persisted.
 */
export const repositoryProfileScriptGroupsSchema = z.record(z.unknown()).nullable();

export const repositoryProfileVersionSchema = z
  .object({
    version: z.number().int().positive(),
    description: markdownSchema,
    rules: markdownSchema,
    relationships: z.array(repositoryRelationshipSchema),
    /** The repository scripts entry, verbatim, or null for a profile that
     *  configures no scripts at all. A null behaves exactly as a repository
     *  absent from the old global blob did: no checks apply to it. */
    scriptGroups: repositoryProfileScriptGroupsSchema,
    /** Which group names the publication gate requires. Null means "every
     *  group this repository declares", which is what omitting it has always
     *  meant; an empty array is refused by the scripts schema, not here. */
    gateGroups: z.array(z.string()).nullable(),
    /** The checks version this profile version carries. Equal to the previous
     *  one when the save changed nothing the checks execute. */
    checksVersion: z.number().int().nonnegative(),
    actorId: z.string(),
    actorLabel: z.string(),
    reason: z.string(),
    createdAt: z.string(),
  })
  .strict();
export type RepositoryProfileVersion = z.infer<typeof repositoryProfileVersionSchema>;

/**
 * Whether the catalog decides access yet.
 *
 * `bridge` is not a second flag: it is `activated === false` named, because
 * every consumer has to answer the same question ("may I treat this catalog as
 * the grant?") and a deployment that has never activated answers "enabled" for
 * every repository it can reach. Carrying the derived name in the contract
 * keeps the dashboard banner and the worker predicate from each deriving it,
 * and disagreeing.
 */
export const repositoryCatalogStateSchema = z
  .object({
    activated: z.boolean(),
    bridge: z.boolean(),
    activatedAt: z.string().nullable(),
    activatedById: z.string().nullable(),
    /** Who activated it, in words. The build-time seed writes its own name here
     *  so a screen can offer a review of an activation nobody clicked. */
    activatedByLabel: z.string().nullable(),
  })
  .strict();
export type RepositoryCatalogState = z.infer<typeof repositoryCatalogStateSchema>;

/**
 * The key every consumer matches a repository on: `provider:owner/name`, cased
 * down.
 *
 * Lower-cased because that is how access has always been decided here (the
 * allowlist compares `repoPath.toLowerCase()`), and a catalog that answered
 * "not enabled" for `Acme/Api` because the row says `acme/api` would be a new
 * way to lose a repository. The STORED path keeps the operator's casing: it is
 * what the composed check configuration carries, and the workspace matches
 * check configuration on the exact string, as it always has.
 */
export function repositoryCatalogKey(
  repository: { provider: string; path: string },
): string {
  return `${repository.provider}:${repository.path.toLowerCase()}`;
}

// The engine spells the same field `repoPath`. There is no second helper for
// it: the one place a `repoPath` reaches the catalog adapts it at the call
// site, so there is exactly one definition of what this key is.

/**
 * Which repositories a run may touch, frozen at its start.
 *
 * The run-start step loads this once and the run context carries it, so a run
 * finishes under the rules it began with and no step or loop pays a database
 * read per repository. It is plain JSON on purpose: it is journaled as a step
 * result and replayed on resume.
 *
 * The bridge (nobody has activated the catalog, so the agent sees everything
 * the installation exposes) is carried as `activated: false` with an empty
 * list, NOT as a list of every repository the providers expose. Listing them
 * would mean a provider call per configured provider at every run start, and
 * the answer would be a second list that the catalog does not own and that
 * could disagree with `isRepositoryDispatchable`, which decides the same
 * question for the same deployment off the same flag.
 */
export interface RunRepositoryAccess {
  /** Whether the catalog decides access. False is the bridge. */
  readonly activated: boolean;
  /** `provider:owner/name`, cased down, for every enabled row, sorted.
   *  Meaningless while `activated` is false. Sorted so two executions of the
   *  run-start step journal the same bytes for the same catalog. */
  readonly enabledKeys: readonly string[];
}

/**
 * May this run touch this repository? Pure, synchronous, no I/O.
 *
 * The shape the engine can accept: the callers are inside loops over
 * repository listings, expansion protocols and workflow bodies, and an await
 * per element would be a database round trip per element. It is deliberately
 * the same question `isRepositoryEnabled` answers for dispatch, off the same
 * two fields, so a repository that may be dispatched may also be reached.
 */
export function isRepositoryAccessible(
  access: RunRepositoryAccess,
  repository: { provider: string; path: string },
): boolean {
  if (!access.activated) return true;
  return access.enabledKeys.includes(repositoryCatalogKey(repository));
}

/** The enabled keys of a catalog listing, sorted, as a run carries them. */
export function runRepositoryEnabledKeys(
  rows: readonly { provider: string; path: string; enabled: boolean }[],
): string[] {
  return [
    ...new Set(
      rows
        .filter((row) => row.enabled)
        .map((row) => repositoryCatalogKey({ provider: row.provider, path: row.path })),
    ),
  ].sort();
}

/**
 * How one suggestion call ended.
 *
 * Recorded for every call, not only the useful ones. A timeout and a malformed
 * answer cost exactly what a proposal costs, and a cost page that showed only
 * the calls that worked would under-report the bill an admin is actually
 * paying while they retry a repository the model keeps failing on.
 */
export const REPOSITORY_SUGGESTION_OUTCOMES = [
  "proposed",
  "timeout",
  "malformed",
  "failed",
  /** The provider does not have this repository any more. Recorded before any
   *  model call, so the row carries no tokens and cost nothing: it is an event
   *  worth seeing on the history, not a bill. */
  "missing",
] as const;
export const repositorySuggestionOutcomeSchema = z.enum(REPOSITORY_SUGGESTION_OUTCOMES);
export type RepositorySuggestionOutcome = z.infer<
  typeof repositorySuggestionOutcomeSchema
>;

/** Longest single check command a suggestion may propose. Long enough for a
 *  real shell line, short enough that a runaway answer is refused rather than
 *  stored. */
export const REPOSITORY_SUGGESTION_COMMAND_MAX_LENGTH = 2_000;
/** How many groups, and how many commands per group, a suggestion may propose.
 *  The admin reviews every one of them by hand, so the bound is the size of a
 *  screen rather than the size of a repository. */
export const REPOSITORY_SUGGESTION_MAX_GROUPS = 12;
export const REPOSITORY_SUGGESTION_MAX_COMMANDS = 12;

/**
 * The answer the model is asked for, before it becomes a proposal.
 *
 * Groups arrive as a LIST of named entries rather than the stored map, and
 * without the provider and the path, for one reason: the identity of the
 * repository is already known here and a model that mistyped it would produce
 * a profile pointing at a repository nobody asked about. The service assembles
 * the proposal from this answer plus the catalog row it was called for.
 *
 * `name` is bounded here but NOT pattern-checked, deliberately. The pattern is
 * in the JSON schema the model is given and is enforced when the answer is
 * turned into a proposal, where a bad name drops one group and lists it under
 * `droppedGroups`. Refusing it here instead would make one mistyped group name
 * void the whole answer, which is a worse outcome for the same mistake and
 * would make the drop mechanism unreachable.
 */
export const repositorySuggestionAnswerSchema = z
  .object({
    description: markdownSchema,
    rules: markdownSchema,
    groups: z
      .array(
        z
          .object({
            name: z.string().min(1).max(REPOSITORY_CATALOG_LABEL_MAX_LENGTH),
            commands: z
              .array(z.string().min(1).max(REPOSITORY_SUGGESTION_COMMAND_MAX_LENGTH))
              .max(REPOSITORY_SUGGESTION_MAX_COMMANDS),
          })
          .strict(),
      )
      .max(REPOSITORY_SUGGESTION_MAX_GROUPS),
  })
  .strict();
export type RepositorySuggestionAnswer = z.infer<typeof repositorySuggestionAnswerSchema>;

/**
 * Why a group the model proposed never reached the proposal.
 *
 * Listed rather than silently dropped: an admin who sees "no test group" has to
 * be able to tell a repository with no tests from a model whose answer was
 * refused, and refusing something invisibly is how a suggestion screen teaches
 * people not to trust it.
 */
export const REPOSITORY_SUGGESTION_DROP_REASONS = [
  /** The command is shaped like remote code execution. */
  "remote_execution",
  /** The group name is not one the checks engine can parse. */
  "invalid_name",
] as const;
export const repositorySuggestionDropReasonSchema = z.enum(
  REPOSITORY_SUGGESTION_DROP_REASONS,
);
export type RepositorySuggestionDropReason = z.infer<
  typeof repositorySuggestionDropReasonSchema
>;

/**
 * True for a command shaped like "fetch something and run it".
 *
 * Small and readable on purpose. This is NOT a sandbox and cannot be one: a
 * determined attacker who controls a repository's README can write a command
 * this does not match. What it stops is the realistic case, a model that read
 * `curl https://install.example | sh` in a README and proposed it as a setup
 * step, and it stops it before a human ever sees it offered as something to
 * tick. The real defence is downstream, in a dashboard that shows every
 * proposed command as a diff to accept one at a time.
 */
export function looksLikeRemoteExecution(command: string): boolean {
  const text = command.toLowerCase();
  return (
    /\|\s*(?:sh|bash|zsh|dash)\b/u.test(text) ||
    /\beval\s*(?:\$\(|")/u.test(text) ||
    /\$\(\s*(?:curl|wget)\b/u.test(text) ||
    /\b(?:curl|wget)\b[^|]*\|/u.test(text) ||
    /(?:^|\s|;|&)sudo\s/u.test(text) ||
    /\bbase64\s+(?:-d|--decode)\b/u.test(text)
  );
}

/**
 * True for a group name the checks engine can actually resolve.
 *
 * The rule is the engine's own (`REPOSITORY_SCRIPT_GROUP_NAME_PATTERN`), not a
 * second one: a name accepted here and refused there would be a profile that
 * saves and then fails to parse at run time, which surfaces as a repository
 * whose checks silently never run. Both the profile save and the suggestion
 * ask this, so the answer is the same on both paths.
 */
export function isRepositoryScriptGroupName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= REPOSITORY_SCRIPT_GROUP_NAME_MAX_LENGTH &&
    REPOSITORY_SCRIPT_GROUP_NAME_PATTERN.test(name)
  );
}

/**
 * The group names in a stored scripts entry that the engine could not resolve.
 *
 * Takes the entry as `unknown` because that is how a profile carries it: the
 * stored shape is deliberately loose, and this narrows exactly as far as it
 * needs to (the `groups` record's keys) rather than parsing the entry a second
 * time in a second dialect.
 */
export function invalidRepositoryScriptGroupNames(entry: unknown): string[] {
  if (typeof entry !== "object" || entry === null) return [];
  const groups = (entry as { groups?: unknown }).groups;
  if (typeof groups !== "object" || groups === null) return [];
  return Object.keys(groups).filter((name) => !isRepositoryScriptGroupName(name));
}

/**
 * A group that survived into the proposal, and where it came from.
 *
 * `provenance` is a field rather than an implicit fact because it has to
 * survive being mapped into a screen's own state. A proposal is not a saved
 * profile and must never be one click away from becoming one; the only shape
 * handed back is this one, and it is NOT the stored script groups entry, so
 * nothing can put a proposal straight into the profile route's body.
 */
export const repositorySuggestionProposedGroupSchema = z
  .object({
    name: z.string(),
    commands: z.array(z.string()),
    provenance: z.literal("model"),
  })
  .strict();
export type RepositorySuggestionProposedGroup = z.infer<
  typeof repositorySuggestionProposedGroupSchema
>;

export const repositorySuggestionDroppedGroupSchema = z
  .object({
    name: z.string(),
    reason: repositorySuggestionDropReasonSchema,
    commands: z.array(z.string()),
  })
  .strict();
export type RepositorySuggestionDroppedGroup = z.infer<
  typeof repositorySuggestionDroppedGroupSchema
>;

/**
 * The same shape as a JSON schema, for the provider's structured output.
 *
 * Kept beside the zod schema and asserted against it by the contracts test, so
 * the two cannot drift: the provider is told one shape and the answer is
 * checked against another only if somebody edits one of these and not the
 * other.
 *
 * **No `$schema` key, and no other dialect marker.** This object is handed to
 * the AI SDK's structured output as-is, and the block path strips exactly that
 * key before sending (`jsonSchemaForProvider` in
 * `apps/worker/src/engine/definition/json-schema.ts`) because the providers
 * refuse or ignore it. Declaring the dialect here would mean either shipping it
 * to the provider or reaching into the engine to remove it again.
 */
export const REPOSITORY_SUGGESTION_ANSWER_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["description", "rules", "groups"],
  properties: {
    description: { type: "string" },
    rules: { type: "string" },
    groups: {
      type: "array",
      maxItems: REPOSITORY_SUGGESTION_MAX_GROUPS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "commands"],
        properties: {
          // The checks engine's own rule, so the model is told the shape rather
          // than corrected afterwards. A name that still misses it drops one
          // group; it never reshapes what the model wrote.
          name: {
            type: "string",
            pattern: REPOSITORY_SCRIPT_GROUP_NAME_PATTERN.source,
            maxLength: REPOSITORY_SCRIPT_GROUP_NAME_MAX_LENGTH,
          },
          commands: {
            type: "array",
            maxItems: REPOSITORY_SUGGESTION_MAX_COMMANDS,
            items: { type: "string" },
          },
        },
      },
    },
  },
} as const;

/**
 * What a suggestion hands back, and it is **not** the shape a profile save
 * takes.
 *
 * `source: "suggested"` and the per-group `provenance` are the point. A
 * proposal is a model's reading of a repository's own files, README prose
 * included, and the one thing it must never be is a body a screen can post. So
 * `scriptGroups` here is a LIST of proposed groups, not the stored entry with
 * its provider and path: turning it into something savable takes deliberate
 * work in the dashboard, which is where the admin accepts each group.
 *
 * An empty list is a model that proposed no checks at all, which is a
 * legitimate answer for a repository that has none.
 */
export const repositorySuggestionProposalSchema = z
  .object({
    source: z.literal("suggested"),
    description: markdownSchema,
    rules: markdownSchema,
    scriptGroups: z.array(repositorySuggestionProposedGroupSchema),
  })
  .strict();
export type RepositorySuggestionProposal = z.infer<
  typeof repositorySuggestionProposalSchema
>;

/**
 * What one suggestion call cost, as the record keeps it.
 *
 * Tokens are what the provider reported; the price is not resolved here,
 * exactly as the call_llm block leaves it, so the cost page prices a whole page
 * of rows at once. A row whose tokens are **null** is **unpriced**: the call
 * ended before the provider reported anything (a timeout, a repository missing
 * at the provider, a bundle that never loaded). A cost page must render those
 * as unpriced rather than as zero, because zero would say the call was free and
 * a timeout against a provider that had already started work is not.
 */
export interface RepositorySuggestionUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}
