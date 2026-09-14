"use client";

import { useEffect, useMemo, useRef } from "react";
import { Button, CkCard, CkChip, Input } from "@/components/ui";
import { filterPrompts } from "@shared/prompts";
import type { PromptLibraryListRowDto } from "@shared/contracts";

/** Compact "3m ago" style relative time for the row meta line. */
function relativeTime(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

function tagChipClass(active: boolean): string {
  return `cursor-pointer rounded-xs border px-2 py-1 font-mono text-[9px] font-medium uppercase tracking-[0.04em] ${
    active ? "border-coal bg-coal text-white" : "border-neutral-200 bg-panel text-neutral-700"
  }`;
}

export function PromptListRail({
  rows,
  tags,
  activeId,
  query,
  onQueryChange,
  tag,
  onTagChange,
  showArchived,
  onToggleArchived,
  onSelect,
  onClearFilters,
}: {
  rows: PromptLibraryListRowDto[];
  tags: string[];
  activeId: number | null;
  query: string;
  onQueryChange: (q: string) => void;
  tag: string | null;
  onTagChange: (t: string | null) => void;
  showArchived: boolean;
  onToggleArchived: () => void;
  onSelect: (id: number) => void;
  onClearFilters: () => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // filterPrompts re-scans every row body, so keep it off the per-keystroke
  // render path: recompute only when the inputs actually change.
  const filtered = useMemo(
    () => filterPrompts(rows, query, tag, { includeArchived: showArchived }),
    [rows, query, tag, showArchived],
  );

  // "/" focuses the search box unless the user is already typing somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      const el = document.activeElement as HTMLElement | null;
      const tagName = el?.tagName;
      if (tagName === "INPUT" || tagName === "TEXTAREA" || el?.isContentEditable) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function focusFirstRow() {
    listRef.current?.querySelector<HTMLButtonElement>("button[data-row]")?.focus();
  }

  return (
    <CkCard
      eyebrow={`Library · ${rows.length} prompts`}
      title="Prompts"
      pad={0}
      className="lg:h-full"
      style={{ display: "flex", flexDirection: "column" }}
    >
      <div className="px-3.5 py-2 border-b border-neutral-200 flex flex-col gap-2">
        <Input
          ref={searchRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              focusFirstRow();
            }
          }}
          placeholder="Search prompts  ( / )"
          aria-label="Search prompts"
        />
        <div className="flex flex-wrap gap-1">
          <Button
            variant="text"
            onClick={() => onTagChange(null)}
            aria-pressed={tag === null}
            className={tagChipClass(tag === null)}
          >
            all
          </Button>
          {tags.map((t) => (
            <Button
              variant="text"
              key={t}
              onClick={() => onTagChange(t)}
              aria-pressed={tag === t}
              className={tagChipClass(tag === t)}
            >
              {t}
            </Button>
          ))}
          <Button
            variant="text"
            onClick={onToggleArchived}
            aria-pressed={showArchived}
            className={`${tagChipClass(showArchived)} ml-auto`}
          >
            Archived
          </Button>
        </div>
      </div>

      <div ref={listRef} className="flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="px-4 py-8 text-center font-body text-[12px] text-neutral-500">
            {query ? `No prompts match "${query}".` : "No prompts here."}
            <div className="mt-2">
              <Button
                variant="text"
                onClick={onClearFilters}
                className="cursor-pointer font-body text-[12px] text-mariner"
              >
                Clear filters
              </Button>
            </div>
          </div>
        ) : (
          filtered.map((row, i) => {
            const on = activeId === row.id;
            const archived = row.archivedAt !== null;
            return (
              <Button
                variant="text"
                type="button"
                key={row.id}
                data-row
                aria-pressed={on}
                onClick={() => onSelect(row.id)}
                className={`block w-full cursor-pointer border-l-[3px] px-4 py-[14px] text-left transition-[color,background-color,border-color] duration-[var(--motion-fast)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-mariner focus-visible:outline-offset-[-2px] ${
                  i < filtered.length - 1 ? "border-b border-b-neutral-200" : ""
                } ${on ? "border-l-mariner bg-off-white" : "border-l-transparent bg-panel hover:bg-[#FAFBFC]"} ${
                  archived ? "opacity-60" : ""
                }`}
              >
                <span className="block w-full">
                  <span className="block truncate font-mono text-[13px] font-semibold text-neutral-900">
                    {row.name}
                  </span>
                  {row.description && (
                    <span className="mt-[3px] block truncate text-[11px] text-neutral-500">
                      {row.description}
                    </span>
                  )}
                  <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[10px] text-neutral-500">
                      v{row.currentVersion} · {relativeTime(row.updatedAt)}
                    </span>
                    {archived && <CkChip tone="neutral">archived</CkChip>}
                    {row.tags.map((t) => (
                      <CkChip key={t} tone={t === "built-in" ? "mariner" : "neutral"}>
                        {t}
                      </CkChip>
                    ))}
                  </span>
                </span>
              </Button>
            );
          })
        )}
      </div>
    </CkCard>
  );
}
