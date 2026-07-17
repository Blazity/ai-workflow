"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PromptLibraryListRowDto, PromptSourceRef } from "@shared/contracts";
import { filterPrompts } from "@/lib/prompt-library/filter";
import { splitSections } from "@/lib/prompt-library/sections";
import { makePromptRef } from "@/lib/prompt-library/provenance";
import { pushRecentPromptId, readRecentPromptIds } from "@/lib/prompt-library/recent";
import { PromptPreview } from "@/components/cockpit/prompt-library/prompt-preview";
import { VariableChips } from "@/components/cockpit/prompt-library/variable-chips";
import { useIsMobileViewport } from "@/lib/use-media-query";
import { usePromptLibrary } from "./prompt-library-context";

export interface PromptInsertPayload {
  text: string;
  /** Set ONLY for whole-prompt Insert/Replace (via makePromptRef); null for
   *  append, section, and selection inserts. */
  ref: PromptSourceRef | null;
  mode: "replace" | "append";
}

export interface PromptInsertPopupProps {
  open: boolean;
  onClose: () => void;
  /** e.g. "Prompt", "System", "Instructions". */
  fieldLabel: string;
  /** Selected node display name. */
  blockName: string;
  targetHasContent: boolean;
  /** Caller applies the payload and closes the popup itself. */
  onInsert: (payload: PromptInsertPayload) => void;
}

type VisibleEntry = { row: PromptLibraryListRowDto; group: "recent" | "all" };

const SearchGlyph = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-neutral-400 shrink-0" aria-hidden="true">
    <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
    <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

/** Small keycap, matching the cockpit's mono utility voice. */
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 font-mono text-[10px] leading-none text-neutral-500 bg-panel border border-neutral-200 rounded-[3px]">
      {children}
    </kbd>
  );
}

const primaryBtn =
  "appearance-none cursor-pointer inline-flex items-center justify-center border border-mariner bg-mariner text-white py-1 px-2.5 rounded-[3px] font-mono text-[11px] tracking-[0.04em] uppercase disabled:opacity-40 min-h-[44px] lg:min-h-0";
const secondaryBtn =
  "appearance-none cursor-pointer inline-flex items-center justify-center border border-neutral-200 bg-panel text-coal py-1 px-2.5 rounded-[3px] font-mono text-[11px] tracking-[0.04em] uppercase hover:bg-app-bg min-h-[44px] lg:min-h-0";
const ghostBtn =
  "appearance-none cursor-pointer inline-flex items-center border-none bg-transparent py-1 px-1.5 font-mono text-[11px] tracking-[0.04em] uppercase text-neutral-600 hover:text-neutral-900 min-h-[44px] lg:min-h-0";

function TagChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`appearance-none cursor-pointer rounded-pill border px-2 py-0.5 font-mono text-[10px] ${
        active
          ? "border-mariner bg-mariner-100 text-mariner"
          : "border-neutral-200 bg-panel text-neutral-600 hover:border-neutral-300"
      }`}
    >
      {label}
    </button>
  );
}

/**
 * Command-palette style picker for inserting a library prompt into a block
 * field. Two panes: a searchable/filterable list on the left, a live preview
 * with per-section insert affordances on the right. A frozen props contract so
 * a later stage can mount it from the block inspector.
 *
 * Not mounted anywhere in this stage; it must compile standalone.
 */
export function PromptInsertPopup({
  open,
  onClose,
  fieldLabel,
  blockName,
  targetHasContent,
  onInsert,
}: PromptInsertPopupProps) {
  const { status, rows, refresh } = usePromptLibrary();
  const isMobile = useIsMobileViewport();

  const [mounted, setMounted] = useState(false);
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [recentIds, setRecentIds] = useState<number[]>([]);
  const [selectionText, setSelectionText] = useState("");
  // Mobile is a two-step flow: 1 = search + list, 2 = preview + actions.
  const [step, setStep] = useState<1 | 2>(1);

  const inputRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const listId = useId();

  useEffect(() => setMounted(true), []);

  const trimmed = query.trim();
  const showGroups = trimmed === "" && tag === null;

  const nonArchived = useMemo(() => rows.filter((r) => r.archivedAt === null), [rows]);
  const tags = useMemo(
    () => Array.from(new Set(nonArchived.flatMap((r) => r.tags))).sort(),
    [nonArchived],
  );
  const filtered = useMemo(() => filterPrompts(rows, query, tag), [rows, query, tag]);
  const entries = useMemo<VisibleEntry[]>(() => {
    if (!showGroups) return filtered.map((row) => ({ row, group: "all" }));
    const byId = new Map(filtered.map((r) => [r.id, r]));
    const recentRows = recentIds
      .map((id) => byId.get(id))
      .filter((r): r is PromptLibraryListRowDto => r != null);
    return [
      ...recentRows.map((row): VisibleEntry => ({ row, group: "recent" })),
      ...filtered.map((row): VisibleEntry => ({ row, group: "all" })),
    ];
  }, [filtered, recentIds, showGroups]);

  const activeIndex = entries.length ? Math.min(active, entries.length - 1) : -1;
  const activeRow = activeIndex >= 0 ? entries[activeIndex].row : null;

  // While open: capture focus, lock body scroll, refresh the library, read the
  // recent list, focus the search input, and dismiss on Escape. Escape must use
  // capture + stopImmediatePropagation so the editor's own window-level Escape
  // handlers (full view, mobile sheet) never fire while this popup is open.
  useEffect(() => {
    if (!open) return;
    restoreFocus.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    setQuery("");
    setTag(null);
    setActive(0);
    setSelectionText("");
    setStep(1);
    setRecentIds(readRecentPromptIds());
    refresh();
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onEsc, { capture: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onEsc, { capture: true });
      document.body.style.overflow = prevOverflow;
      restoreFocus.current?.focus?.();
    };
  }, [open, refresh, onClose]);

  // Reset the active row when the visible set changes.
  useEffect(() => {
    setActive(0);
  }, [trimmed, tag]);

  // Keep the active option in view as the selection moves by keyboard.
  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(`${listId}-opt-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, listId]);

  // Selection-insert (desktop only): track a non-collapsed selection whose
  // anchor sits inside the preview pane so the "Insert selection" action lights.
  useEffect(() => {
    if (!open || isMobile) return;
    const onSel = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !previewRef.current) {
        setSelectionText("");
        return;
      }
      const anchor = sel.anchorNode;
      if (anchor && previewRef.current.contains(anchor)) setSelectionText(sel.toString());
      else setSelectionText("");
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, [open, isMobile]);

  const applyInsert = useCallback(
    (payload: PromptInsertPayload, rowId: number) => {
      pushRecentPromptId(rowId);
      onInsert(payload);
    },
    [onInsert],
  );

  const insertWhole = (row: PromptLibraryListRowDto) =>
    applyInsert(
      { text: row.body, ref: makePromptRef(row.id, row.currentVersion, row.body), mode: "replace" },
      row.id,
    );
  const appendWhole = (row: PromptLibraryListRowDto) =>
    applyInsert({ text: row.body, ref: null, mode: "append" }, row.id);
  const insertPart = (row: PromptLibraryListRowDto, text: string) =>
    applyInsert({ text, ref: null, mode: targetHasContent ? "append" : "replace" }, row.id);
  // Enter: append into a filled field, otherwise insert into an empty one.
  const primaryInsert = (row: PromptLibraryListRowDto) =>
    targetHasContent ? appendWhole(row) : insertWhole(row);

  const onRowActivate = (i: number) => {
    setActive(i);
    if (isMobile) setStep(2);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (entries.length ? (i + 1) % entries.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (entries.length ? (i - 1 + entries.length) % entries.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!activeRow) return;
      if (e.metaKey || e.ctrlKey) insertWhole(activeRow);
      else primaryInsert(activeRow);
    }
  };

  if (!mounted || !open) return null;

  const canInsertSelection = !isMobile && selectionText.trim().length > 0;

  const searchInput = (
    <input
      ref={inputRef}
      type="text"
      role="combobox"
      aria-expanded={entries.length > 0}
      aria-controls={listId}
      aria-autocomplete="list"
      aria-activedescendant={activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined}
      value={query}
      onChange={(e) => setQuery(e.target.value)}
      onKeyDown={onKeyDown}
      placeholder="Search prompts by name, tag, or text"
      aria-label="Search prompts by name, tag, or text"
      className="flex-1 min-w-0 bg-transparent border-none outline-none font-body text-[15px] text-neutral-900 placeholder:text-neutral-400"
    />
  );

  const tagChips =
    tags.length > 0 ? (
      <div className="flex items-center gap-1.5 flex-wrap px-4 py-2 border-b border-neutral-200 shrink-0">
        <TagChip label="all" active={tag === null} onClick={() => setTag(null)} />
        {tags.map((t) => (
          <TagChip key={t} label={t} active={tag === t} onClick={() => setTag(t)} />
        ))}
      </div>
    ) : null;

  // Left-pane list content: states first, then the grouped/flat options.
  let listContent: React.ReactNode;
  if (status === "loading") {
    listContent = <div className="px-4 py-6 font-mono text-[11px] text-neutral-500">Loading library…</div>;
  } else if (status === "error") {
    listContent = (
      <div className="px-4 py-6 font-body text-[13px] text-neutral-600">
        Could not load the prompt library.{" "}
        <button
          type="button"
          onClick={refresh}
          className="appearance-none cursor-pointer border-none bg-transparent p-0 font-body text-[13px] font-semibold text-mariner"
        >
          Retry
        </button>
      </div>
    );
  } else if (nonArchived.length === 0) {
    listContent = (
      <div className="px-4 py-8 flex flex-col items-center gap-1 text-center">
        <p className="font-body text-[13px] text-neutral-700 m-0">No prompts in your library yet.</p>
        <p className="font-body text-[12px] text-neutral-500 m-0">Create them under Prompts.</p>
      </div>
    );
  } else if (entries.length === 0) {
    listContent = (
      <div className="px-4 py-6 font-body text-[13px] text-neutral-500">No prompts match “{trimmed}”.</div>
    );
  } else {
    const options: React.ReactNode[] = [];
    let lastGroup: string | null = null;
    entries.forEach((entry, i) => {
      if (showGroups && entry.group !== lastGroup) {
        lastGroup = entry.group;
        options.push(
          <div
            key={`grp-${entry.group}`}
            className="px-4 pt-3 pb-1 font-mono text-[9px] uppercase tracking-[0.08em] text-neutral-500"
          >
            {entry.group === "recent" ? "Recent" : "All"}
          </div>,
        );
      }
      const row = entry.row;
      const isActive = i === activeIndex;
      options.push(
        <button
          key={`${listId}-opt-${i}`}
          id={`${listId}-opt-${i}`}
          role="option"
          aria-selected={isActive}
          type="button"
          onMouseEnter={() => setActive(i)}
          onClick={() => onRowActivate(i)}
          className={`relative w-full appearance-none border-none cursor-pointer text-left flex flex-col gap-0.5 pl-4 pr-3 py-2 ${
            isActive ? "bg-off-white" : "bg-panel"
          }`}
        >
          {isActive && (
            <span className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full bg-mariner" aria-hidden="true" />
          )}
          <span className="truncate font-mono text-[12px] font-semibold text-neutral-900">{row.name}</span>
          <span className="truncate font-mono text-[10px] text-neutral-500">
            {`v${row.currentVersion}${row.tags.length ? ` · ${row.tags.join(", ")}` : ""}`}
          </span>
        </button>,
      );
    });
    listContent = options;
  }

  const preview = activeRow ? (
    <div className="flex flex-col min-h-0 h-full">
      <div className="shrink-0 bg-panel border-b border-neutral-200 px-4 py-2.5 flex flex-col gap-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="m-0 truncate font-display text-[15px] font-semibold text-neutral-900">{activeRow.name}</h3>
          <span className="shrink-0 rounded-full border border-neutral-200 bg-off-white px-1.5 py-0.5 font-mono text-[10px] text-neutral-600">
            v{activeRow.currentVersion}
          </span>
        </div>
        <VariableChips body={activeRow.body} />
      </div>
      <div ref={previewRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-2">
        {splitSections(activeRow.body).map((section, si) => (
          <div
            key={si}
            className="group relative -mx-2 rounded-[3px] border border-transparent px-2 py-1 hover:border-neutral-200"
          >
            <button
              type="button"
              onClick={() => insertPart(activeRow, section.body)}
              className="absolute right-2 top-1 z-10 appearance-none cursor-pointer rounded-[3px] border border-mariner bg-panel px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.04em] text-mariner opacity-100 transition-opacity lg:opacity-0 lg:group-hover:opacity-100"
            >
              Insert section
            </button>
            <PromptPreview body={section.body} />
          </div>
        ))}
      </div>
    </div>
  ) : (
    <div className="flex h-full items-center justify-center px-4 font-body text-[12px] text-neutral-400">
      Select a prompt to preview.
    </div>
  );

  const actions = activeRow ? (
    <>
      {canInsertSelection && (
        <button type="button" onClick={() => insertPart(activeRow, selectionText)} className={ghostBtn}>
          Insert selection
        </button>
      )}
      {targetHasContent ? (
        <>
          <button type="button" onClick={() => insertWhole(activeRow)} className={secondaryBtn}>
            Replace field
          </button>
          <button type="button" onClick={() => appendWhole(activeRow)} className={primaryBtn}>
            Append
          </button>
        </>
      ) : (
        <button type="button" onClick={() => insertWhole(activeRow)} className={primaryBtn}>
          Insert
        </button>
      )}
    </>
  ) : null;

  const legend = (
    <div className="flex items-center gap-2 font-mono text-[10px] text-neutral-500">
      <span className="inline-flex items-center gap-1.5">
        <Kbd>↑↓</Kbd> navigate
      </span>
      <span aria-hidden="true">·</span>
      <span className="inline-flex items-center gap-1.5">
        <Kbd>↩</Kbd> {targetHasContent ? "append" : "insert"}
      </span>
      <span aria-hidden="true">·</span>
      <span className="inline-flex items-center gap-1.5">
        <Kbd>⌘↩</Kbd> replace
      </span>
      <span aria-hidden="true">·</span>
      <span className="inline-flex items-center gap-1.5">
        <Kbd>esc</Kbd> close
      </span>
    </div>
  );

  // --- Mobile: full-screen, two-step (search → preview) ---
  if (isMobile) {
    return createPortal(
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Insert prompt from library"
        className="fixed inset-0 z-[100] flex flex-col bg-panel animate-ck-pop motion-reduce:animate-none"
      >
        {step === 1 ? (
          <>
            <div className="flex items-center gap-2 h-[52px] px-3 border-b border-neutral-200 shrink-0">
              <SearchGlyph />
              {searchInput}
              <button
                type="button"
                onClick={onClose}
                className="appearance-none cursor-pointer border-none bg-transparent font-mono text-[11px] uppercase tracking-[0.04em] text-neutral-500"
              >
                Close
              </button>
            </div>
            {tagChips}
            <div id={listId} role="listbox" aria-label="Prompt library" className="flex-1 min-h-0 overflow-y-auto">
              {listContent}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 h-[52px] px-3 border-b border-neutral-200 shrink-0">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="appearance-none cursor-pointer border-none bg-transparent font-body text-[14px] text-mariner"
              >
                ‹ Back
              </button>
              <span className="ml-auto truncate font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
                {blockName} · {fieldLabel}
              </span>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">{preview}</div>
            <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-neutral-200 bg-off-white shrink-0">
              {actions}
            </div>
          </>
        )}
      </div>,
      document.body,
    );
  }

  // --- Desktop: centered two-pane palette ---
  return createPortal(
    <div
      role="presentation"
      onMouseDown={onClose}
      className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[12vh] bg-coal/50 backdrop-blur-[2px]"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Insert prompt from library"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex w-full max-w-[820px] flex-col overflow-hidden rounded-md bg-panel shadow-[0_24px_64px_-16px_rgba(24,27,32,0.45)] animate-ck-pop motion-reduce:animate-none"
      >
        <div className="flex items-center gap-3 px-4 h-[60px] border-b border-neutral-200 shrink-0">
          <SearchGlyph />
          {searchInput}
          <span className="shrink-0 truncate max-w-[220px] font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
            {blockName} · {fieldLabel}
          </span>
          <Kbd>esc</Kbd>
        </div>
        {tagChips}
        <div className="grid grid-cols-[280px_1fr] max-h-[min(60vh,520px)]">
          <div
            id={listId}
            role="listbox"
            aria-label="Prompt library"
            className="min-h-0 overflow-y-auto border-r border-neutral-200"
          >
            {listContent}
          </div>
          <div className="min-h-0 overflow-hidden">{preview}</div>
        </div>
        <div className="flex items-center gap-3 px-4 h-9 border-t border-neutral-200 bg-off-white shrink-0">
          {legend}
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
