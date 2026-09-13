import {
  REPOSITORY_RELATIONSHIP_KINDS,
  type RepositoryRelationshipKind,
} from "@shared/contracts";
import type { RepositoryMetadata } from "../../adapters/vcs/repository-directory.js";

/** Repository candidates resolved before sandbox execution begins. */

export const MAX_ACCESSIBLE_REPOSITORIES = 200;
const MAX_DESCRIPTION_LENGTH = 240;
const MAX_TOPIC_COUNT = 8;
const MAX_TOPIC_LENGTH = 40;

export interface RepositoryCatalogEntry {
  provider: RepositoryMetadata["provider"];
  repoPath: string;
  name: string;
  defaultBranch: string;
  description: string;
  topics: string[];
  /** Catalog relationship sentences, loaded when discovery runs. */
  relationships: string[];
  usable: boolean;
  unusableReason?: "missing_default_branch";
}

export interface RepositoryCatalogRelationship {
  direction: "outgoing" | "incoming";
  repositoryId: number;
  provider: string;
  path: string;
  enabled: boolean;
  kind: RepositoryRelationshipKind;
  note: string | null;
}

export interface RepositoryRelationshipSource {
  key: string;
  relationships: RepositoryCatalogRelationship[];
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
      const key = `${relationship.repositoryId}:${relationship.kind}`;
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

/** Add discovery relationship context to provider metadata with no I/O. */
export function addRepositoryDiscoveryRelationships(input: {
  catalog: readonly RepositoryCatalogEntry[];
  sources: readonly RepositoryRelationshipSource[];
  attachedKeys: readonly string[];
  enabledKeys: readonly string[];
}): RepositoryCatalogEntry[] {
  const sources = new Map(input.sources.map((source) => [source.key, source]));
  return input.catalog.map((repository) => {
    const key = repositoryCatalogKey(repository);
    return {
      ...repository,
      relationships: renderRepositoryRelationshipLines({
        ownerKey: `${repository.provider}:${repository.repoPath}`,
        relationships: sources.get(key)?.relationships ?? [],
        attachedKeys: input.attachedKeys,
        enabledKeys: input.enabledKeys,
      }),
    };
  });
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
