import type {
  ParsedPromptReference,
  PromptLibraryDetailResponse,
  PromptLibraryListRowDto,
} from "@shared/contracts";

export type ReferencePreviewResolution =
  | { kind: "ready"; body: string }
  | { kind: "needs-detail" }
  | { kind: "missing-version" };

export function resolveReferencePreview(
  reference: ParsedPromptReference,
  row: PromptLibraryListRowDto,
  detail?: PromptLibraryDetailResponse,
): ReferencePreviewResolution {
  if (reference.version === "latest" || reference.version === row.currentVersion) {
    return { kind: "ready", body: row.body };
  }
  if (!detail) return { kind: "needs-detail" };

  const version = detail.versions.find((candidate) => candidate.version === reference.version);
  return version
    ? { kind: "ready", body: version.body }
    : { kind: "missing-version" };
}
