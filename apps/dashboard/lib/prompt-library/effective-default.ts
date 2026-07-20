import {
  formatPromptReferenceToken,
  type PromptLibraryListRowDto,
} from "@shared/contracts";

export function effectiveDefaultPromptValue(
  value: string,
  promptName: string | undefined,
  rows: readonly PromptLibraryListRowDto[],
): { value: string; implicit: boolean } {
  if (value.trim().length > 0 || !promptName) return { value, implicit: false };
  const row = rows.find(
    (candidate) => candidate.name === promptName && candidate.archivedAt === null,
  );
  return {
    value: row
      ? formatPromptReferenceToken({ promptId: row.id, version: "latest" })
      : "",
    implicit: true,
  };
}
