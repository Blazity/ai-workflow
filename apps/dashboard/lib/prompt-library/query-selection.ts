import type { PromptLibraryListRowDto } from "@shared/contracts";

export function initialPromptSelection(
  queryValue: string | null,
  rows: readonly PromptLibraryListRowDto[],
): number | null {
  const activeRows = rows.filter((row) => row.archivedAt === null);
  const requestedId = queryValue && /^[1-9]\d*$/.test(queryValue)
    ? Number(queryValue)
    : null;

  if (requestedId !== null && Number.isSafeInteger(requestedId)) {
    const requested = activeRows.find((row) => row.id === requestedId);
    if (requested) return requested.id;
  }

  return activeRows[0]?.id ?? null;
}
