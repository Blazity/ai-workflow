"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatPromptReferenceToken } from "@shared/contracts";
import { PromptPreview } from "@/components/cockpit/prompt-library/prompt-preview";
import {
  appendComposerSection,
  insertComposerMarkdown,
  moveComposerBlock,
  parseComposerBlocks,
  removeComposerBlock,
  serializeComposerBlocks,
  updateComposerBlock,
  type ComposerBlock,
} from "@/lib/prompt-library/composer";
import { PromptEditor } from "./prompt-editor";
import { PromptReferenceChips } from "./prompt-reference-chips";
import { readPromptDrag, writePromptDrag } from "./prompt-drag";

const iconButton =
  "inline-flex size-7 shrink-0 appearance-none items-center justify-center rounded-[3px] border border-transparent bg-transparent font-mono text-[11px] text-neutral-500 transition-colors hover:border-neutral-200 hover:bg-off-white hover:text-mariner disabled:cursor-default disabled:opacity-30";

function DropTarget({
  index,
  active,
  onDrop,
  onHover,
}: {
  index: number;
  active: boolean;
  onDrop: (event: React.DragEvent, index: number) => void;
  onHover: (index: number | null) => void;
}) {
  return (
    <div
      onDragEnter={(event) => {
        event.preventDefault();
        onHover(index);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onHover(null);
      }}
      onDrop={(event) => onDrop(event, index)}
      className="relative h-2 shrink-0"
      aria-hidden="true"
    >
      <div className={`absolute inset-x-1 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-mariner transition-opacity duration-100 ${active ? "opacity-100" : "opacity-0"}`} />
    </div>
  );
}

export function PromptSectionComposer({
  value,
  onChange,
  disabled,
  syncRequest,
}: {
  value: string;
  onChange: (markdown: string) => void;
  disabled?: boolean;
  syncRequest?: { id: number; mode: "replace" | "append" } | null;
}) {
  const nextId = useRef(0);
  const makeId = useCallback(() => `composer-${++nextId.current}`, []);
  const [blocks, setBlocks] = useState<ComposerBlock[]>(() => parseComposerBlocks(value, makeId));
  const [raw, setRaw] = useState(false);
  const [rawValue, setRawValue] = useState(value);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const lastEmitted = useRef(value);
  const scrollRef = useRef<HTMLDivElement>(null);
  const handledSyncRequest = useRef<number | null>(null);

  useEffect(() => {
    if (value === lastEmitted.current) return;
    setBlocks(parseComposerBlocks(value, makeId));
    setRawValue(value);
    lastEmitted.current = value;
  }, [makeId, value]);

  useEffect(() => {
    if (!syncRequest || handledSyncRequest.current === syncRequest.id) return;
    handledSyncRequest.current = syncRequest.id;
    const frame = requestAnimationFrame(() => {
      const surface = scrollRef.current;
      if (!surface) return;
      surface.scrollTop = syncRequest.mode === "append" ? surface.scrollHeight : 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [syncRequest]);

  const commit = (next: ComposerBlock[]) => {
    const markdown = serializeComposerBlocks(next);
    setBlocks(next);
    setRawValue(markdown);
    lastEmitted.current = markdown;
    onChange(markdown);
  };

  const updateBlock = (id: string, markdown: string) => {
    const next = updateComposerBlock(blocks, id, markdown, makeId);
    commit(next);
    if (!next.some((block) => block.id === id)) setActiveId(null);
  };

  const handleDrop = (event: React.DragEvent, targetIndex: number) => {
    event.preventDefault();
    const payload = readPromptDrag(event);
    setDropIndex(null);
    if (!payload || disabled) return;
    if (payload.kind === "composer-block") {
      const sourceIndex = blocks.findIndex((block) => block.id === payload.blockId);
      if (sourceIndex === -1) return;
      const adjustedTarget = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
      commit(moveComposerBlock(blocks, payload.blockId, adjustedTarget));
      return;
    }
    const markdown = payload.kind === "library-reference"
      ? formatPromptReferenceToken({
          slug: payload.slug,
          version: payload.version ?? "latest",
        })
      : payload.markdown;
    const next = insertComposerMarkdown(blocks, targetIndex, markdown, makeId);
    commit(next);
    setActiveId(next[targetIndex]?.kind === "section" ? next[targetIndex].id : null);
  };

  const toggleRaw = () => {
    if (raw) {
      const next = parseComposerBlocks(rawValue, makeId);
      setBlocks(next);
      setActiveId(null);
      lastEmitted.current = rawValue;
    } else {
      setRawValue(serializeComposerBlocks(blocks));
    }
    setRaw((current) => !current);
  };

  const addSection = () => {
    if (disabled) return;
    const next = appendComposerSection(blocks, makeId);
    commit(next.blocks);
    setActiveId(next.sectionId);
    requestAnimationFrame(() => {
      scrollRef.current
        ?.querySelector(`[data-composer-block="${next.sectionId}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  };

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden rounded-[3px] border border-neutral-200 bg-panel">
      <div className="flex h-9 shrink-0 items-center border-b border-neutral-200 px-2">
        <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-500">
          {raw ? "Markdown" : `${blocks.length} ${blocks.length === 1 ? "block" : "blocks"}`}
        </span>
        {!raw && (
          <button
            type="button"
            onClick={addSection}
            disabled={disabled}
            className="ml-auto rounded-[3px] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.04em] text-mariner hover:bg-mariner-100 disabled:opacity-40"
          >
            + New section
          </button>
        )}
        <button
          type="button"
          onClick={toggleRaw}
          className={`${raw ? "ml-auto bg-mariner-100 text-mariner" : "ml-1 text-neutral-600 hover:bg-off-white"} rounded-[3px] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.04em]`}
        >
          Raw
        </button>
      </div>

      {raw ? (
        <textarea
          value={rawValue}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value;
            setRawValue(next);
            lastEmitted.current = next;
            onChange(next);
          }}
          className="min-h-0 w-full min-w-0 flex-1 resize-none border-none bg-panel px-3 py-2 font-mono text-[12px] leading-[1.6] text-coal outline-none"
          aria-label="Raw prompt markdown"
        />
      ) : (
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto bg-off-white p-3"
          onDragEnd={() => setDropIndex(null)}
        >
          <DropTarget index={0} active={dropIndex === 0} onDrop={handleDrop} onHover={setDropIndex} />
          {blocks.length === 0 && (
            <div
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => handleDrop(event, 0)}
              className="grid min-h-[220px] place-items-center rounded-md border border-dashed border-neutral-300 bg-panel px-6 text-center font-body text-[12px] text-neutral-500"
            >
              Drag a prompt or section here, or choose New section to start writing.
            </div>
          )}
          {blocks.map((block, index) => {
            const active = !disabled && activeId === block.id && block.kind === "section";
            return (
              <div key={block.id}>
                <article
                  data-composer-block={block.id}
                  className={`overflow-hidden rounded-md border bg-panel transition-[border-color,box-shadow] duration-150 ${
                    active ? "border-mariner-200 shadow-[0_4px_14px_rgba(31,90,166,0.10)]" : "border-neutral-200 shadow-[0_2px_8px_rgba(24,27,32,0.04)]"
                  }`}
                >
                  <div className="flex h-9 items-center gap-2 border-b border-neutral-100 px-2">
                    <button
                      type="button"
                      draggable={!disabled}
                      onDragStart={(event) => {
                        if (disabled) return;
                        writePromptDrag(event, { kind: "composer-block", blockId: block.id, label: block.title });
                      }}
                      aria-label={`Drag ${block.title}`}
                      className={`${iconButton} cursor-grab active:cursor-grabbing`}
                    >
                      ⠿
                    </button>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] font-semibold text-neutral-700">
                      {block.kind === "reference" ? "Live prompt" : block.level === 0 ? "Introduction" : `H${block.level}`} · {block.title}
                    </span>
                    <button type="button" disabled={disabled || index === 0} onClick={() => commit(moveComposerBlock(blocks, block.id, index - 1))} className={iconButton} aria-label="Move up">↑</button>
                    <button type="button" disabled={disabled || index === blocks.length - 1} onClick={() => commit(moveComposerBlock(blocks, block.id, index + 1))} className={iconButton} aria-label="Move down">↓</button>
                    <button type="button" disabled={disabled} onClick={() => commit(removeComposerBlock(blocks, block.id))} className={iconButton} aria-label="Remove block">×</button>
                  </div>

                  {block.kind === "reference" ? (
                    <div className="px-3 py-2.5">
                      <PromptReferenceChips
                        value={block.body}
                        onChange={(markdown) => updateBlock(block.id, markdown)}
                        disabled={disabled}
                      />
                    </div>
                  ) : active ? (
                    <div className="p-2">
                      <PromptEditor
                        value={block.body}
                        onChange={(markdown) => updateBlock(block.id, markdown)}
                        minHeightClass="min-h-[120px]"
                        autoFocus
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => setActiveId(block.id)}
                      className="block w-full appearance-none border-none bg-transparent px-3 py-2.5 text-left"
                    >
                      <PromptPreview body={block.body} />
                    </button>
                  )}
                </article>
                <DropTarget index={index + 1} active={dropIndex === index + 1} onDrop={handleDrop} onHover={setDropIndex} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
