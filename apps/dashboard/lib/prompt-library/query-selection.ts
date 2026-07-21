import type { PromptLibraryListRowDto } from "@shared/contracts";

/** Resolves the ?prompt= query value onto a library row. New links carry the
 *  slug; numeric values stay accepted so pre-slug links keep working. */
export function initialPromptSelection(
  queryValue: string | null,
  rows: readonly PromptLibraryListRowDto[],
): number | null {
  const activeRows = rows.filter((row) => row.archivedAt === null);

  if (queryValue) {
    const requested = /^[1-9]\d*$/.test(queryValue)
      ? activeRows.find((row) => row.id === Number(queryValue))
      : activeRows.find((row) => row.slug === queryValue);
    if (requested) return requested.id;
  }

  return activeRows[0]?.id ?? null;
}
