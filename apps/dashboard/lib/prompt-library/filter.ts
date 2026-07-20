import type { PromptLibraryListRowDto } from "@shared/contracts";

/** Filter library rows by a free-text query and an optional exact tag. The
 *  query matches case-insensitively as a substring of the name, description,
 *  any tag, or the body. Archived rows are excluded unless opts.includeArchived
 *  is set. An empty query with a null tag returns every row (still respecting
 *  the archived rule). */
export function filterPrompts(
  rows: readonly PromptLibraryListRowDto[],
  query: string,
  tag: string | null,
  opts?: { includeArchived?: boolean },
): PromptLibraryListRowDto[] {
  const includeArchived = opts?.includeArchived ?? false;
  const q = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (row.archivedAt !== null && !includeArchived) return false;
    if (tag !== null && !row.tags.includes(tag)) return false;
    if (q.length > 0) {
      const fields = [row.name, row.description ?? "", ...row.tags, row.body];
      if (!fields.some((f) => f.toLowerCase().includes(q))) return false;
    }
    return true;
  });
}
