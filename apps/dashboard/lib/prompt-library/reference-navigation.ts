import type { PromptReferenceSelector } from "@shared/contracts";

export type PromptPreviewRequest = {
  requestId: number;
  promptId: number;
  version: PromptReferenceSelector;
};

export type PromptPreviewTarget = Omit<PromptPreviewRequest, "requestId">;

export function promptLibraryHref(promptId: number): string {
  return `/prompts?prompt=${promptId}`;
}

export function promptReferenceCapabilities(resolved: boolean, disabled: boolean) {
  return {
    canExpand: resolved,
    canOpenLibrary: resolved,
    canMutate: resolved && !disabled,
  };
}

export function resolvePreviewSelection(
  request: PromptPreviewRequest,
  rows: readonly { id: number; currentVersion: number }[],
  availableVersions: readonly number[],
): { activeId: number; selectedVersion: number; missingVersion: boolean } | null {
  const row = rows.find((candidate) => candidate.id === request.promptId);
  if (!row) return null;
  const selectedVersion = request.version === "latest" ? row.currentVersion : request.version;
  return {
    activeId: row.id,
    selectedVersion,
    missingVersion: !availableVersions.includes(selectedVersion),
  };
}
