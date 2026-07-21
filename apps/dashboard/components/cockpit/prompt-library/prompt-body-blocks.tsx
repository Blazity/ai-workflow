"use client";

import { useMemo } from "react";
import type { PromptLibraryListRowDto } from "@shared/contracts";
import { usePromptLibrary } from "@/components/cockpit/flow-editor/prompt-library-context";
import { PromptReferenceChipsView } from "@/components/cockpit/prompt-editor/prompt-reference-chips";
import { parseComposerBlocks } from "@/lib/prompt-library/composer";
import { PromptPreview } from "./prompt-preview";

const noop = () => {};

/** Read-only sectioned render of a prompt body: the same block structure the
 *  composer edits (sections as cards, references as live-reference cards), so
 *  the library detail view and the editor share one visual language. A body
 *  with no headings and no references falls back to a flat preview. */
export function PromptBodyBlocksView({
  body,
  rows,
  maxHeightClass,
}: {
  body: string;
  rows: readonly PromptLibraryListRowDto[];
  maxHeightClass?: string;
}) {
  const blocks = useMemo(() => {
    let id = 0;
    return parseComposerBlocks(body, () => `body-block-${++id}`);
  }, [body]);

  const flat =
    blocks.length <= 1 && blocks.every((block) => block.kind === "section" && block.level === 0);
  const content = flat ? (
    <PromptPreview body={body} />
  ) : (
    <div className="flex flex-col gap-2">
      {blocks.map((block) => (
        <article
          key={block.id}
          className="overflow-hidden rounded-md border border-neutral-200 bg-panel shadow-[0_2px_8px_rgba(24,27,32,0.04)]"
        >
          {block.kind === "reference" ? (
            <div className="px-3 py-2.5">
              <PromptReferenceChipsView value={block.body} onChange={noop} disabled rows={rows} />
            </div>
          ) : (
            <>
              <div className="flex h-8 items-center gap-2 border-b border-neutral-100 px-3">
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] font-semibold text-neutral-700">
                  {block.level === 0 ? "Introduction" : `H${block.level}`} · {block.title}
                </span>
              </div>
              <div className="px-3 py-2.5">
                <PromptPreview body={block.body} />
              </div>
            </>
          )}
        </article>
      ))}
    </div>
  );

  if (maxHeightClass) {
    return <div className={`${maxHeightClass} overflow-y-auto`}>{content}</div>;
  }
  return content;
}

export function PromptBodyBlocks(props: { body: string; maxHeightClass?: string }) {
  const { rows } = usePromptLibrary();
  return <PromptBodyBlocksView {...props} rows={rows} />;
}
