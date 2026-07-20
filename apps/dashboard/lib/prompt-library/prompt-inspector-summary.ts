import { parsePromptReferenceTokens, type PromptLibraryListRowDto } from "@shared/contracts";

export type PromptInspectorSummary = {
  kind: "reference" | "custom" | "empty";
  title: string;
  detail: string;
  preview?: string;
};

export function promptInspectorSummary(
  value: string,
  effectiveValue: string,
  implicitName: string | undefined,
  rows: readonly PromptLibraryListRowDto[],
): PromptInspectorSummary {
  const trimmed = effectiveValue.trim();
  const references = parsePromptReferenceTokens(trimmed);
  const onlyReference = references.length === 1 && references[0].raw === trimmed;
  if (onlyReference) {
    const reference = references[0];
    const row = rows.find((candidate) => candidate.id === reference.promptId);
    const explicitReference = value.trim() === trimmed;
    const missingTitle = `Missing prompt ${reference.promptId}`;
    return {
      kind: "reference",
      title: row?.name ?? (explicitReference ? missingTitle : implicitName ?? missingTitle),
      detail:
        reference.version === "latest"
          ? `Latest${row ? ` · v${row.currentVersion}` : ""}`
          : `Pinned v${reference.version}`,
    };
  }
  if (value.trim()) {
    return {
      kind: "custom",
      title: "Custom prompt",
      detail: `${value.length} chars · ~${Math.ceil(value.length / 4)} tokens`,
      preview: value.replace(/\s+/g, " ").trim(),
    };
  }
  if (implicitName) return { kind: "reference", title: implicitName, detail: "Latest" };
  return { kind: "empty", title: "No prompt configured", detail: "Open the editor to add one" };
}
