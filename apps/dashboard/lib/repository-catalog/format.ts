// apps/dashboard/lib/repository-catalog/format.ts
//
// Reading a catalog row for a screen: the labels, the counts and the one line
// of description a list has room for. Pure, so the copy every state depends on
// is tested without rendering anything.
import type {
  PrePrCheckRepositoryConfig,
  RepositoryCatalogEntry,
  RepositoryCatalogSource,
  RepositoryProfileVersion,
  RepositorySuggestionUsage,
} from "@shared/contracts";

/** What the source badge says. Provenance in the operator's words, not the
 *  stored enum: nothing branches on it, it exists so a row nobody remembers
 *  creating can be told apart from one somebody typed. */
const SOURCE_LABELS: Record<RepositoryCatalogSource, string> = {
  imported: "imported",
  manual: "manual",
  seeded: "seeded",
  migrated: "migrated",
};

export function sourceLabel(source: RepositoryCatalogSource): string {
  return SOURCE_LABELS[source] ?? source;
}

/**
 * The first line of a markdown description, for a list row.
 *
 * Leading blank lines and a leading `#` are dropped, because a description
 * pasted as a document starts with its own title and a row reading "# acme/web"
 * says nothing the row does not already say. Nothing else is parsed: this is a
 * list cell, not a renderer.
 */
export function firstLine(markdown: string, maxLength = 140): string {
  const line =
    markdown
      .split("\n")
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate.length > 0) ?? "";
  const stripped = line.replace(/^#{1,6}\s+/, "").trim();
  return stripped.length > maxLength
    ? `${stripped.slice(0, maxLength - 1).trimEnd()}…`
    : stripped;
}

/** The stored scripts entry, narrowed just far enough to read. It is kept loose
 *  in the contract on purpose (the publication gate fingerprints stored bytes),
 *  so this never reshapes it. */
export function asScriptsEntry(
  scriptGroups: Record<string, unknown> | null,
): PrePrCheckRepositoryConfig | null {
  if (scriptGroups === null) return null;
  return scriptGroups as unknown as PrePrCheckRepositoryConfig;
}

/**
 * When a repository was last changed, and by whom.
 *
 * Read off the CURRENT profile version rather than the row's `updatedAt`: the
 * row also moves when somebody flips the enabled switch, and a list that
 * reported a switch as "last change · v4" would send an operator looking for an
 * edit that never happened. A repository with no profile has never been
 * configured, and says so.
 */
export function lastChangeLabel(profile: RepositoryProfileVersion | null): string {
  if (profile === null) return "never configured";
  return `v${profile.version} · ${profile.actorLabel} · ${formatDateTime(profile.createdAt)}`;
}

export function formatDateTime(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}

/**
 * What one suggestion call cost, in words.
 *
 * **Null tokens are "unpriced", never zero.** The call ended before the
 * provider reported anything (a timeout, a repository missing at the provider,
 * a refusal before the call), and zero would say the call was free. A timeout
 * against a provider that had already started work is not free, and a cost row
 * that says it is teaches an operator to stop reading the column.
 */
export function usageLabel(usage: RepositorySuggestionUsage | null): string {
  if (usage === null) return "unpriced";
  const total = usage.inputTokens + usage.outputTokens;
  const cached = usage.cachedTokens > 0 ? `, ${usage.cachedTokens} cached` : "";
  return `${total} tokens (${usage.inputTokens} in, ${usage.outputTokens} out${cached})`;
}

/** The row's one-line identity for a dialog or a link title. */
export function repositoryLabel(repository: {
  displayName: string;
  path: string;
}): string {
  const name = repository.displayName.trim();
  return name.length > 0 && name !== repository.path
    ? `${name} (${repository.path})`
    : repository.path;
}

/** Sorted for a list: enabled first is deliberately NOT the rule. An operator
 *  looks a repository up by name, and a list that reorders itself when a switch
 *  is flipped moves the row out from under the click that flipped it. */
export function sortRepositories(
  repositories: readonly RepositoryCatalogEntry[],
): RepositoryCatalogEntry[] {
  return [...repositories].sort((a, b) =>
    `${a.provider}:${a.path}`.localeCompare(`${b.provider}:${b.path}`),
  );
}
