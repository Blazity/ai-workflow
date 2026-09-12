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
