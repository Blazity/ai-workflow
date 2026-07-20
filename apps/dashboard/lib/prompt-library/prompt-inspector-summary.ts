import {
  parsePromptReferenceTokens,
  promptReferenceMatchesRow,
  promptReferenceTargetLabel,
  type PromptLibraryListRowDto,
} from "@shared/contracts";
import { parseComposerBlocks } from "./composer";

export type PromptInspectorSummary =
  | { kind: "reference" | "empty"; title: string; detail: string }
  | {
      kind: "custom";
      title: string;
      detail: string;
      sectionTitles: string[];
      remainingSectionCount: number;
    };

function promptStructure(value: string, rows: readonly PromptLibraryListRowDto[]) {
  let id = 0;
  const blocks = parseComposerBlocks(value, () => `summary-${++id}`);
  const titles = blocks.map((block) => {
    if (block.kind !== "reference") return block.title;
    const reference = parsePromptReferenceTokens(block.body)[0];
    return (reference && rows.find((row) => promptReferenceMatchesRow(reference, row))?.name)
      ?? (reference ? `Missing prompt ${promptReferenceTargetLabel(reference)}` : block.title);
  });
  return {
    blockCount: blocks.length,
    referenceCount: blocks.filter((block) => block.kind === "reference").length,
    sectionTitles: titles.slice(0, 3),
    remainingSectionCount: Math.max(0, titles.length - 3),
  };
}

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
    const row = rows.find((candidate) => promptReferenceMatchesRow(reference, candidate));
    const explicitReference = value.trim() === trimmed;
    const missingTitle = `Missing prompt ${promptReferenceTargetLabel(reference)}`;
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
    const structure = promptStructure(value, rows);
    const sections = `${structure.blockCount} ${structure.blockCount === 1 ? "section" : "sections"}`;
    const references = structure.referenceCount > 0
      ? ` · ${structure.referenceCount} ${structure.referenceCount === 1 ? "live prompt" : "live prompts"}`
      : "";
    return {
      kind: "custom",
      title: "Custom prompt",
      detail: `${value.length} chars · ~${Math.ceil(value.length / 4)} tokens · ${sections}${references}`,
      sectionTitles: structure.sectionTitles,
      remainingSectionCount: structure.remainingSectionCount,
    };
  }
  if (implicitName) return { kind: "reference", title: implicitName, detail: "Latest" };
  return { kind: "empty", title: "No prompt configured", detail: "Open the editor to add one" };
}
