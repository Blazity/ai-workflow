import {
  REPOSITORY_RELATIONSHIP_KINDS,
  type RepositoryRelationshipKind,
} from "@shared/contracts";
import type { RepositoryMetadata } from "../../adapters/vcs/repository-directory.js";
import type { RepositoryMapFacts } from "../../repository-map/map.js";

/** Repository candidates resolved before sandbox execution begins. */

export const MAX_ACCESSIBLE_REPOSITORIES = 200;
/**
 * The provider's listing blurb is one line of marketing and never more.
 *
 * The operator's own description is a different thing and gets its own bound
 * below: somebody typed it for exactly this moment, and cutting it to the size
 * of a GitHub tagline throws away the half that says which flows live where.
 */
const MAX_DESCRIPTION_LENGTH = 240;
/**
 * The operator's description inside the discovery catalog.
 *
 * Set deliberately rather than inherited: the field may hold 20,000 characters
 * (`REPOSITORY_CATALOG_MARKDOWN_MAX_LENGTH`), discovery renders the whole
 * catalog as JSON, and 200 repositories times 20,000 characters is a prompt
 * nothing survives. Four times the provider's bound is room for the paragraph
 * an operator actually writes, and a cut one says it was cut.
 */
const MAX_CATALOG_DESCRIPTION_LENGTH = 960;
/**
 * What every operator description in the discovery catalog costs TOGETHER.
 *
 * The per-repository bound above bounds one repository, and the catalog holds
 * up to 200 of them: 960 characters each is up to 192,000, where the provider
 * text it replaced was capped at 48,000 for the same catalog. A prompt section
 * is cut at 200,000 characters from the end, so a catalog of well-documented
 * repositories was one bound away from deleting whatever discovery says after
 * it. Past this, the remaining repositories keep the provider's shorter text:
 * degraded, labelled as the provider's, and never silently half a paragraph.
 */
const MAX_CATALOG_DESCRIPTION_TOTAL = 48_000;
const MAX_TOPIC_COUNT = 8;
const MAX_TOPIC_LENGTH = 40;

export interface RepositoryCatalogEntry {
  provider: RepositoryMetadata["provider"];
  repoPath: string;
  name: string;
  defaultBranch: string;
  description: string;
  /** Whose words `description` is. Absent on an entry built before the catalog
   *  profile reached discovery, which reads as the provider's, because that is
   *  what those entries carried. */
  descriptionSource?: "catalog" | "provider" | "none";
  topics: string[];
  /** Catalog relationship sentences, loaded when discovery runs. */
  relationships: string[];
  usable: boolean;
  unusableReason?: "missing_default_branch";
}

export interface RepositoryCatalogRelationship {
  direction: "outgoing" | "incoming";
  /** Absent on a relationship that arrived through the repository map, which
   *  identifies the other end by its key. Identity de-duplication below uses
   *  that key, so the id is provenance rather than something it depends on. */
  repositoryId?: number;
  provider: string;
  path: string;
  enabled: boolean;
  kind: RepositoryRelationshipKind;
  note: string | null;
}


const MAX_RENDERED_REPOSITORY_RELATIONSHIPS = 20;

/** Render relationship lines without I/O using access sets supplied by the caller. */
export function renderRepositoryRelationshipLines(input: {
  ownerKey: string;
  relationships: readonly RepositoryCatalogRelationship[];
  attachedKeys: readonly string[];
  enabledKeys?: readonly string[];
}): string[] {
  const attached = new Set(input.attachedKeys.map((key) => key.toLowerCase()));
  const enabled = input.enabledKeys
    ? new Set(input.enabledKeys.map((key) => key.toLowerCase()))
    : null;
  const vocabulary = new Map(
    REPOSITORY_RELATIONSHIP_KINDS.map((entry) => [entry.kind, entry]),
  );
  const byIdentity = new Map<string, RepositoryCatalogRelationship>();
  for (const direction of ["outgoing", "incoming"] as const) {
    for (const relationship of input.relationships) {
      if (relationship.direction !== direction) continue;
      // The other end plus the kind. It was the row id, which a relationship
      // read by key does not carry; the key identifies the same repository,
      // and the catalog fails closed on two rows that collapse to one key.
      const key = `${relationship.provider}:${relationship.path.toLowerCase()}:${relationship.kind}`;
      if (!byIdentity.has(key)) byIdentity.set(key, relationship);
    }
  }
  const markerRank = (relationship: RepositoryCatalogRelationship) => {
    const key = `${relationship.provider}:${relationship.path}`.toLowerCase();
    if (attached.has(key)) return 0;
    if (enabled ? enabled.has(key) : relationship.enabled) return 1;
    return 2;
  };
  const ordered = [...byIdentity.values()].sort((left, right) =>
    markerRank(left) - markerRank(right) ||
    (left.direction === "outgoing" ? 0 : 1) -
      (right.direction === "outgoing" ? 0 : 1) ||
    `${left.provider}:${left.path}`.localeCompare(`${right.provider}:${right.path}`) ||
    left.kind.localeCompare(right.kind),
  );
  const omitted = Math.max(
    ordered.length - MAX_RENDERED_REPOSITORY_RELATIONSHIPS,
    0,
  );
  const lines = ordered
    .slice(0, MAX_RENDERED_REPOSITORY_RELATIONSHIPS)
    .flatMap((relationship) => {
      const definition = vocabulary.get(relationship.kind);
      if (!definition) return [];
      const other = `${relationship.provider}:${relationship.path}`;
      const sentence =
        relationship.direction === "outgoing" || definition.symmetric
          ? definition.sentence.replace("{target}", other)
          : definition.inverseSentence.replace("{source}", other);
      const otherKey = other.toLowerCase();
      const marker = attached.has(otherKey)
        ? "attached to this run"
        : enabled
          ? enabled.has(otherKey)
            ? "enabled in the catalog"
            : "not enabled"
          : relationship.enabled
            ? "enabled in the catalog"
            : "not enabled";
      return [
        `${input.ownerKey} ${sentence} (${marker})${relationship.note ? ` (${relationship.note})` : ""}`,
      ];
    });
  if (omitted > 0) lines.push(`${omitted} related repositories omitted.`);
  return lines;
}

/**
 * Add the catalog's own knowledge to provider metadata, with no I/O: the
 * operator's description in place of the provider's listing blurb, and the
 * relationship sentences.
 *
 * WHOSE WORDS THE MODEL READS. Discovery described every repository with the
 * provider's listing text, which is whatever somebody typed into a GitHub
 * "About" box years ago, while the description an operator wrote on the
 * Repositories page for exactly this purpose reached nothing. The operator's
 * words win, the provider's stay as a labelled fallback, and every entry says
 * which it got, so a person auditing a briefing can tell a decision made here
 * from a blurb we inherited.
 */
export function addRepositoryDiscoveryRelationships(input: {
  catalog: readonly RepositoryCatalogEntry[];
  /** The catalog profiles this run read, as the repository map reads them. */
  facts: readonly RepositoryMapFacts[];
  attachedKeys: readonly string[];
  enabledKeys: readonly string[];
}): RepositoryCatalogEntry[] {
  const facts = new Map(input.facts.map((entry) => [entry.key, entry] as const));
  // Spent in catalog order, which is the order the catalog was built in, so
  // the same catalog spends it the same way on every run.
  let descriptionBudget = MAX_CATALOG_DESCRIPTION_TOTAL;
  return input.catalog.map((repository) => {
    const key = repositoryCatalogKey(repository);
    const fact = facts.get(key);
    const candidate = catalogDescription(fact?.catalogDescription ?? "");
    const described = candidate !== null && candidate.length <= descriptionBudget ? candidate : null;
    if (described !== null) descriptionBudget -= described.length;
    return {
      ...repository,
      ...(described !== null
        ? { description: described, descriptionSource: "catalog" as const }
        : {
            descriptionSource:
              repository.description.length > 0 ? ("provider" as const) : ("none" as const),
          }),
      relationships: renderRepositoryRelationshipLines({
        ownerKey: `${repository.provider}:${repository.repoPath}`,
        relationships: (fact?.relationships ?? []).map((relationship) => ({
          direction: relationship.direction,
          provider: relationship.targetKey.slice(0, relationship.targetKey.indexOf(":")),
          path: relationship.targetKey.slice(relationship.targetKey.indexOf(":") + 1),
          enabled: input.enabledKeys.includes(relationship.targetKey),
          kind: relationship.kind as RepositoryRelationshipKind,
          note: relationship.note ?? null,
        })),
        attachedKeys: input.attachedKeys,
        enabledKeys: input.enabledKeys,
      }),
    };
  });
}

/** The operator's description as discovery may carry it, or null when they
 *  wrote none. A cut one says so, because a model shown half a paragraph with
 *  no marker reads it as the whole thing an operator meant. */
function catalogDescription(description: string): string | null {
  const collapsed = description.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  if (collapsed.length <= MAX_CATALOG_DESCRIPTION_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_CATALOG_DESCRIPTION_LENGTH)}... (shortened; the full description is on the Repositories page)`;
}

export class RepositoryCatalogError extends Error {
  constructor(
    message: string,
    readonly code:
      | "catalog_limit_exceeded"
      | "invalid_repository_path"
      | "catalog_case_collision",
  ) {
    super(message);
    this.name = "RepositoryCatalogError";
  }
}

export function buildRepositoryCatalog(
  repositories: RepositoryMetadata[],
): RepositoryCatalogEntry[] {
  const available = repositories.filter((repository) => !repository.archived);
  if (available.length > MAX_ACCESSIBLE_REPOSITORIES) {
    throw new RepositoryCatalogError(
      `Accessible repository catalog exceeds ${MAX_ACCESSIBLE_REPOSITORIES} entries`,
      "catalog_limit_exceeded",
    );
  }

  return toCatalogEntries(available);
}

// Unbounded variant for deterministic repository selection, which must not fail
// on catalog size. The bounded `buildRepositoryCatalog` remains the only path
// that hands a catalog to model discovery or expansion.
export function buildRepositoryCatalogEntries(
  repositories: RepositoryMetadata[],
): RepositoryCatalogEntry[] {
  return toCatalogEntries(
    repositories.filter((repository) => !repository.archived),
  );
}

function toCatalogEntries(
  available: RepositoryMetadata[],
): RepositoryCatalogEntry[] {
  const entries = available
    .map((repository) => {
      if (!isValidProviderPath(repository.provider, repository.repoPath)) {
        throw new RepositoryCatalogError(
          `Invalid ${repository.provider} repository path: ${repository.repoPath}`,
          "invalid_repository_path",
        );
      }
      const defaultBranch = repository.defaultBranch.trim();
      return {
        provider: repository.provider,
        repoPath: repository.repoPath,
        name: repository.name.slice(0, 100),
        defaultBranch,
        description: repository.description.slice(0, MAX_DESCRIPTION_LENGTH),
        topics: repository.topics
          .slice(0, MAX_TOPIC_COUNT)
          .map((topic) => topic.slice(0, MAX_TOPIC_LENGTH)),
        relationships: [],
        usable: defaultBranch.length > 0,
        ...(defaultBranch.length === 0
          ? { unusableReason: "missing_default_branch" as const }
          : {}),
      };
    })
    .sort((left, right) =>
      repositoryCatalogKey(left).localeCompare(repositoryCatalogKey(right)),
    );

  // Fail closed on entries that collapse to the same case-insensitive key.
  // Downstream Maps key by the lowercased provider-scoped key, so a collision
  // (e.g. gitlab group/Repo vs group/repo) would silently drop one of the pair.
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = repositoryCatalogKey(entry);
    if (seen.has(key)) {
      throw new RepositoryCatalogError(
        `Repository catalog contains a case-insensitive key collision: ${key}`,
        "catalog_case_collision",
      );
    }
    seen.add(key);
  }

  return entries;
}

export function repositoryCatalogKey(
  repository: Pick<RepositoryCatalogEntry, "provider" | "repoPath">,
): string {
  return `${repository.provider}:${repository.repoPath.toLowerCase()}`;
}

function isValidProviderPath(
  provider: RepositoryMetadata["provider"],
  repoPath: string,
): boolean {
  const segments = repoPath.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9_.-]+$/.test(segment),
    )
  ) {
    return false;
  }
  return provider === "github" ? segments.length === 2 : segments.length >= 2;
}
