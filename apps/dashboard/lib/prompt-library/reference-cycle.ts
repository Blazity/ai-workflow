import {
  parsePromptReferenceTokens,
  promptReferenceMatchesRow,
  type PromptLibraryListRowDto,
} from "@shared/contracts";

/**
 * Authoring-time cycle check: would inserting a reference to `insertedSlug`
 * into the prompt `fromSlug` close a reference loop? Walks the ACTIVE prompts'
 * head bodies; every token counts as an edge to that prompt's head (a
 * conservative approximation of the runtime resolver, which also follows
 * pinned versions). Returns the closed path (`[from, inserted, ..., from]`)
 * or null when the insert is safe. The runtime still rejects cycles at run
 * time; this exists so the editor can refuse them with context instead.
 */
export function findReferenceCycle(
  rows: readonly PromptLibraryListRowDto[],
  fromSlug: string,
  insertedSlug: string,
): string[] | null {
  if (fromSlug === insertedSlug) return [fromSlug, fromSlug];

  const activeBySlug = new Map(
    rows.filter((row) => row.archivedAt === null).map((row) => [row.slug, row]),
  );

  const referencedSlugs = (slug: string): string[] => {
    const row = activeBySlug.get(slug);
    if (!row) return [];
    const targets = new Set<string>();
    for (const token of parsePromptReferenceTokens(row.body)) {
      const target = rows.find((candidate) => promptReferenceMatchesRow(token, candidate));
      if (target) targets.add(target.slug);
    }
    return [...targets];
  };

  // DFS from the inserted prompt looking for a path back to the edited one.
  // `path` always starts with fromSlug, so reaching fromSlug closes it.
  const visited = new Set<string>();
  const walk = (slug: string, path: string[]): string[] | null => {
    if (slug === fromSlug) return [...path];
    if (visited.has(slug)) return null;
    visited.add(slug);
    for (const next of referencedSlugs(slug)) {
      const found = walk(next, [...path, next]);
      if (found) return found;
    }
    return null;
  };

  return walk(insertedSlug, [fromSlug, insertedSlug]);
}
