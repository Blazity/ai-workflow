import {
  parsePromptReferenceTokens,
  promptReferenceTargetLabel,
  type ParsedPromptReference,
} from "@shared/contracts";
import { splitSections } from "./sections.ts";

interface ComposerBlockBase {
  id: string;
  title: string;
  body: string;
}

export interface ComposerSectionBlock extends ComposerBlockBase {
  kind: "section";
  level: number;
}

export interface ComposerReferenceBlock extends ComposerBlockBase {
  kind: "reference";
  reference: Pick<ParsedPromptReference, "slug" | "legacyPromptId" | "version">;
}

export type ComposerBlock = ComposerSectionBlock | ComposerReferenceBlock;
export type ComposerIdFactory = () => string;

function sectionBlocks(markdown: string, makeId: ComposerIdFactory): ComposerSectionBlock[] {
  if (markdown.trim().length === 0) return [];
  return splitSections(markdown)
    .filter((section) => section.body.trim().length > 0)
    .map((section) => ({
      id: makeId(),
      kind: "section" as const,
      title: section.title,
      level: section.level,
      body: section.body,
    }));
}

export function parseComposerBlocks(markdown: string, makeId: ComposerIdFactory): ComposerBlock[] {
  const references = parsePromptReferenceTokens(markdown);
  if (references.length === 0) return sectionBlocks(markdown, makeId);

  const blocks: ComposerBlock[] = [];
  let cursor = 0;
  for (const token of references) {
    blocks.push(...sectionBlocks(markdown.slice(cursor, token.start), makeId));
    const reference = { slug: token.slug, legacyPromptId: token.legacyPromptId, version: token.version };
    blocks.push({
      id: makeId(),
      kind: "reference",
      title: `Prompt ${promptReferenceTargetLabel(token)}`,
      body: token.raw,
      reference,
    });
    cursor = token.end;
  }
  blocks.push(...sectionBlocks(markdown.slice(cursor), makeId));
  return blocks;
}

function canonicalBody(body: string): string {
  return body.replace(/^\n+/, "").replace(/\n+$/, "");
}

export function serializeComposerBlocks(blocks: readonly ComposerBlock[]): string {
  return blocks.map((block) => canonicalBody(block.body)).filter(Boolean).join("\n\n");
}

export function insertComposerMarkdown(
  blocks: readonly ComposerBlock[],
  targetIndex: number,
  markdown: string,
  makeId: ComposerIdFactory,
): ComposerBlock[] {
  const inserted = parseComposerBlocks(markdown, makeId);
  const index = Math.max(0, Math.min(targetIndex, blocks.length));
  return [...blocks.slice(0, index), ...inserted, ...blocks.slice(index)];
}

export function moveComposerBlock(
  blocks: readonly ComposerBlock[],
  id: string,
  targetIndex: number,
): ComposerBlock[] {
  const sourceIndex = blocks.findIndex((block) => block.id === id);
  if (sourceIndex === -1) return [...blocks];
  const next = [...blocks];
  const [moved] = next.splice(sourceIndex, 1);
  const index = Math.max(0, Math.min(targetIndex, next.length));
  next.splice(index, 0, moved);
  return next;
}

export function updateComposerBlock(
  blocks: readonly ComposerBlock[],
  id: string,
  markdown: string,
  makeId: ComposerIdFactory,
): ComposerBlock[] {
  const index = blocks.findIndex((block) => block.id === id);
  if (index === -1) return [...blocks];
  let replacement = parseComposerBlocks(markdown, makeId);
  // A section whose text is momentarily empty (select-all + delete while
  // typing) must keep its card: dropping it would unmount the editor mid-edit.
  // Removal stays an explicit action; serialize skips empty bodies anyway.
  if (replacement.length === 0 && blocks[index].kind === "section") {
    replacement = [{ ...blocks[index], body: markdown }];
  }
  if (replacement.length > 0) replacement[0] = { ...replacement[0], id };
  return [...blocks.slice(0, index), ...replacement, ...blocks.slice(index + 1)];
}

export function removeComposerBlock(blocks: readonly ComposerBlock[], id: string): ComposerBlock[] {
  return blocks.filter((block) => block.id !== id);
}

export function appendComposerSection(
  blocks: readonly ComposerBlock[],
  makeId: ComposerIdFactory,
): { blocks: ComposerBlock[]; sectionId: string } {
  const sectionId = makeId();
  const section: ComposerSectionBlock = {
    id: sectionId,
    kind: "section",
    title: "New section",
    level: 2,
    body: "## New section",
  };
  return { blocks: [...blocks, section], sectionId };
}
