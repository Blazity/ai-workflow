"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  formatPromptReferenceToken,
  type PromptLibraryDetailResponse,
  type PromptLibraryListRowDto,
} from "@shared/contracts";
import { filterPrompts } from "@/lib/prompt-library/filter";
import { splitSections } from "@/lib/prompt-library/sections";
import { makePromptRef } from "@/lib/prompt-library/provenance";
import { PromptPreview } from "@/components/cockpit/prompt-library/prompt-preview";
import { VariableChips } from "@/components/cockpit/prompt-library/variable-chips";
import { usePromptLibrary } from "./prompt-library-context";
import type { PromptInsertPayload } from "./prompt-insert-popup";
import { writePromptDrag } from "@/components/cockpit/prompt-editor/prompt-drag";
import {
  resolvePreviewSelection,
  type PromptPreviewRequest,
} from "@/lib/prompt-library/reference-navigation";

const pressable = "transition-transform duration-150 ease-standard active:scale-[0.96]";
const primaryBtn = `flex-1 appearance-none cursor-pointer inline-flex items-center justify-center border border-mariner bg-mariner text-white py-1.5 px-2 rounded-[3px] font-mono text-[10px] tracking-[0.04em] uppercase ${pressable}`;
const secondaryBtn = `flex-1 appearance-none cursor-pointer inline-flex items-center justify-center border border-neutral-200 bg-panel text-coal py-1.5 px-2 rounded-[3px] font-mono text-[10px] tracking-[0.04em] uppercase hover:bg-app-bg ${pressable}`;

function TagChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`appearance-none cursor-pointer rounded-pill border px-2 py-0.5 font-mono text-[9px] transition-colors duration-150 ${
        active ? "border-mariner bg-mariner-100 text-mariner" : "border-neutral-200 bg-panel text-neutral-600 hover:border-neutral-300"
      }`}
    >
      {label}
    </button>
  );
}

/**
 * Inline library browser for the prompt editor modal — search + list + a preview
 * that supports inserting the whole prompt OR individual sections, from a chosen
 * version. Rendered as a panel (not a stacked modal). The list reads the shared
 * library context (already loaded); a prompt's version history is lazy-fetched on
 * select. Inserts route through `onInsert`, which the modal forwards to the field.
 */
export function PromptLibraryRail({
  disabled,
  onInsert,
  targetHasContent,
  previewRequest,
  excludeId,
}: {
  disabled?: boolean;
  onInsert: (payload: PromptInsertPayload) => void;
  targetHasContent: boolean;
  previewRequest?: PromptPreviewRequest | null;
  /** Hide this prompt from the rail (library mode edits it; a latest
   *  self-reference would be an instant cycle). */
  excludeId?: number;
}) {
  const { status, rows: allRows } = usePromptLibrary();
  const rows = useMemo(
    () => (excludeId === undefined ? allRows : allRows.filter((row) => row.id !== excludeId)),
    [allRows, excludeId],
  );
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [detailCache, setDetailCache] = useState<Map<number, PromptLibraryDetailResponse>>(new Map());
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [activePreviewRequest, setActivePreviewRequest] = useState<PromptPreviewRequest | null>(null);
  const [missingVersion, setMissingVersion] = useState(false);
  const activeIdRef = useRef<number | null>(null);
  const previewPaneRef = useRef<HTMLDivElement>(null);
  const handledPreviewRequestId = useRef(0);
  // Read by the row-change effect without being one of its deps: clearing the
  // request (e.g. the version select's onChange) must never re-run that effect,
  // or it would reset the version the user just picked back to head.
  const previewRequestRef = useRef<PromptPreviewRequest | null>(null);
  previewRequestRef.current = activePreviewRequest;

  const nonArchived = useMemo(() => rows.filter((r) => r.archivedAt === null), [rows]);
  const tags = useMemo(() => Array.from(new Set(nonArchived.flatMap((r) => r.tags))).sort(), [nonArchived]);
  const filtered = useMemo(() => filterPrompts(rows, query, tag), [rows, query, tag]);
  const activeRow: PromptLibraryListRowDto | null =
    (activeId !== null ? filtered.find((r) => r.id === activeId) : undefined) ?? filtered[0] ?? null;

  useEffect(() => {
    // Apply each request exactly once: without the handled guard, a later rows
    // refresh would re-run this effect and yank the selection back to the
    // requested prompt after the user already browsed elsewhere.
    if (!previewRequest || handledPreviewRequestId.current === previewRequest.requestId) return;
    const row = nonArchived.find((candidate) => candidate.id === previewRequest.promptId);
    if (!row) return;
    handledPreviewRequestId.current = previewRequest.requestId;
    setQuery("");
    setTag(null);
    setActiveId(row.id);
    setActivePreviewRequest(previewRequest);
    setSelectedVersion(previewRequest.version === "latest" ? row.currentVersion : previewRequest.version);
    setMissingVersion(false);
    const frame = requestAnimationFrame(() => {
      if (previewPaneRef.current) previewPaneRef.current.scrollTop = 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [nonArchived, previewRequest]);

  // On active-prompt change ONLY: reset the version to head (or the pending
  // preview request's version, read via ref) and lazy-load the prompt's history
  // (bodies of older versions) so they can be previewed and inserted. This must
  // not depend on activePreviewRequest: clearing it while staying on the same
  // row (version select onChange) would otherwise clobber the user's pick.
  useEffect(() => {
    const id = activeRow?.id ?? null;
    activeIdRef.current = id;
    const request = previewRequestRef.current;
    const requestedVersion = request?.promptId === id ? request.version : null;
    setSelectedVersion(activeRow
      ? requestedVersion === "latest"
        ? activeRow.currentVersion
        : requestedVersion ?? activeRow.currentVersion
      : null);
    setMissingVersion(false);
    if (id === null || detailCache.has(id)) return;
    let alive = true;
    fetch(`/api/prompt-library/${id}`)
      .then((res) => (res.ok ? (res.json() as Promise<PromptLibraryDetailResponse>) : Promise.reject()))
      .then((detail) => {
        if (alive) setDetailCache((m) => new Map(m).set(id, detail));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRow?.id]);

  const detail = activeRow ? detailCache.get(activeRow.id) : undefined;
  const versions = detail?.versions ?? [];
  useEffect(() => {
    if (!activeRow || !detail || activePreviewRequest?.promptId !== activeRow.id) return;
    const selection = resolvePreviewSelection(
      activePreviewRequest,
      nonArchived,
      versions.map((version) => version.version),
    );
    if (!selection) return;
    setSelectedVersion(selection.selectedVersion);
    setMissingVersion(selection.missingVersion);
  }, [activePreviewRequest, activeRow, detail, nonArchived, versions]);

  const versionLoading = Boolean(
    activeRow
      && activePreviewRequest?.promptId === activeRow.id
      && activePreviewRequest.version !== "latest"
      && activePreviewRequest.version !== activeRow.currentVersion
      && !detail,
  );
  const activeBody = useMemo(() => {
    if (!activeRow || missingVersion || versionLoading) return "";
    const v = selectedVersion != null ? detail?.versions.find((x) => x.version === selectedVersion) : undefined;
    if (v) return v.body;
    return selectedVersion === activeRow.currentVersion ? activeRow.body : "";
  }, [activeRow, detail, missingVersion, selectedVersion, versionLoading]);
  const sections = useMemo(() => (activeRow ? splitSections(activeBody) : []), [activeBody, activeRow]);

  const copyWhole = () => {
    if (disabled) return;
    if (activeRow) onInsert({
      text: activeBody,
      ref: targetHasContent
        ? null
        : makePromptRef(activeRow.id, selectedVersion ?? activeRow.currentVersion, activeBody),
      mode: targetHasContent ? "append" : "replace",
    });
  };
  const insertReference = (version: "latest" | number) => {
    if (disabled) return;
    if (activeRow) onInsert({
      text: formatPromptReferenceToken({ slug: activeRow.slug, version }),
      ref: null,
      mode: targetHasContent ? "append" : "replace",
    });
  };
  const insertSection = (text: string) => {
    if (disabled) return;
    onInsert({ text, ref: null, mode: targetHasContent ? "append" : "replace" });
  };
  const sectionActionLabel = targetHasContent ? "Append section" : "Insert section";

  let listContent: React.ReactNode;
  if (nonArchived.length === 0 && status === "loading") {
    listContent = <div className="px-3 py-6 font-mono text-[11px] text-neutral-500">Loading library…</div>;
  } else if (nonArchived.length === 0 && status === "error") {
    listContent = <div className="px-3 py-6 font-body text-[12px] text-neutral-600">Could not load the library.</div>;
  } else if (nonArchived.length === 0) {
    listContent = (
      <div className="px-3 py-6 font-body text-[12px] text-neutral-600">No prompts yet. Create them under Prompts.</div>
    );
  } else if (filtered.length === 0) {
    listContent = <div className="px-3 py-6 font-body text-[12px] text-neutral-500">No prompts match.</div>;
  } else {
    listContent = filtered.map((row) => {
      const isActive = activeRow?.id === row.id;
      return (
        <button
          key={row.id}
          type="button"
          onClick={() => {
            setActivePreviewRequest(null);
            setMissingVersion(false);
            setActiveId(row.id);
          }}
          className={`relative block w-full appearance-none cursor-pointer border-none pl-3 pr-2.5 py-2 text-left transition-colors duration-150 ${
            isActive ? "bg-off-white" : "bg-panel hover:bg-off-white"
          }`}
        >
          <span
            className={`absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-mariner origin-center transition-[opacity,transform] duration-150 ease-standard ${
              isActive ? "opacity-100 scale-y-100" : "opacity-0 scale-y-50"
            }`}
            aria-hidden="true"
          />
          <span className="block truncate font-mono text-[12px] font-semibold text-neutral-900">{row.name}</span>
          <span className="block truncate font-mono text-[10px] text-neutral-500">
            {`v${row.currentVersion}${row.tags.length ? ` · ${row.tags.join(", ")}` : ""}`}
          </span>
        </button>
      );
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="shrink-0 border-b border-neutral-200 px-3 py-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search prompts…"
          aria-label="Search prompts"
          className="w-full rounded-[3px] border border-neutral-200 bg-off-white px-2 py-1.5 font-body text-[12px] text-neutral-900 outline-none focus:border-mariner"
        />
        {tags.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <TagChip label="all" active={tag === null} onClick={() => setTag(null)} />
            {tags.map((t) => (
              <TagChip key={t} label={t} active={tag === t} onClick={() => setTag(t)} />
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 basis-[34%] overflow-y-auto border-b border-neutral-200">{listContent}</div>

      {activeRow ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-neutral-200 px-3 py-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                draggable={!disabled}
                onDragStart={(event) => writePromptDrag(event, {
                  kind: "library-reference",
                  slug: activeRow.slug,
                  label: activeRow.name,
                })}
                aria-label={`Drag ${activeRow.name} as latest reference`}
                title="Drag as latest reference"
                className="inline-flex size-7 shrink-0 cursor-grab items-center justify-center rounded-[3px] border border-transparent bg-transparent font-mono text-[12px] text-neutral-400 hover:border-neutral-200 hover:bg-off-white hover:text-mariner active:cursor-grabbing"
              >
                ⠿
              </button>
              <h3 className="m-0 min-w-0 flex-1 truncate font-display text-[13px] font-semibold text-neutral-900">
                {activeRow.name}
              </h3>
              {missingVersion ? (
                <span className="shrink-0 rounded-full border border-yellow-300 bg-[#FFF4CC] px-1.5 py-0.5 font-mono text-[9px] text-neutral-700">
                  v{selectedVersion} unavailable
                </span>
              ) : versions.length > 1 ? (
                <select
                  value={selectedVersion ?? activeRow.currentVersion}
                  onChange={(e) => {
                    setActivePreviewRequest(null);
                    setMissingVersion(false);
                    setSelectedVersion(Number(e.target.value));
                  }}
                  aria-label="Version"
                  className="shrink-0 cursor-pointer appearance-none rounded-[3px] border border-neutral-200 bg-off-white px-1.5 py-0.5 font-mono text-[10px] text-neutral-700 outline-none focus:border-mariner"
                >
                  {versions.map((v) => (
                    <option key={v.version} value={v.version}>
                      v{v.version}
                      {v.version === activeRow.currentVersion ? " · current" : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="shrink-0 rounded-full border border-neutral-200 bg-off-white px-1.5 py-0.5 font-mono text-[9px] text-neutral-600">
                  v{activeRow.currentVersion}
                </span>
              )}
            </div>
            <div className="mt-1.5">
              <VariableChips body={activeBody} />
            </div>
          </div>

          <div ref={previewPaneRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {missingVersion ? (
              <div className="grid min-h-[160px] place-items-center rounded-[3px] border border-dashed border-yellow-300 bg-[#FFF9E6] px-4 text-center font-body text-[12px] text-neutral-600">
                Version v{selectedVersion} unavailable.
              </div>
            ) : versionLoading ? (
              <div className="px-2 py-6 font-mono text-[11px] text-neutral-500">Loading version…</div>
            ) : (
            <div className="flex flex-col gap-1.5">
              {sections.map((section, si) => (
                <div
                  key={si}
                  className="group/section relative -mx-1.5 rounded-[3px] border border-transparent py-1 pl-8 pr-1.5 transition-colors duration-150 hover:border-neutral-200 hover:bg-off-white focus-within:border-mariner-200 focus-within:bg-off-white"
                >
                  <button
                    type="button"
                    draggable={!disabled}
                    onDragStart={(event) => writePromptDrag(event, {
                      kind: "library-section",
                      markdown: section.body,
                      label: section.title,
                    })}
                    aria-label={`Drag section ${section.title}`}
                    title="Drag section"
                    className="absolute left-1 top-1 inline-flex size-7 cursor-grab items-center justify-center rounded-[3px] border border-transparent bg-transparent font-mono text-[11px] text-neutral-400 opacity-50 hover:border-neutral-200 hover:bg-panel hover:text-mariner group-hover/section:opacity-100 focus-visible:opacity-100 active:cursor-grabbing"
                  >
                    ⠿
                  </button>
                  {!disabled && (
                    <button
                      type="button"
                      onClick={() => insertSection(section.body)}
                      aria-label={`${sectionActionLabel}: ${section.title}`}
                      title={sectionActionLabel}
                      className="absolute right-1.5 top-1.5 z-10 inline-flex min-h-7 appearance-none items-center rounded-[3px] border border-mariner-200 bg-panel px-2 font-mono text-[9px] uppercase tracking-[0.04em] text-mariner opacity-0 pointer-events-none shadow-[0_2px_8px_rgba(24,27,32,0.08)] transition-[opacity,transform] duration-150 ease-standard before:absolute before:-inset-1.5 group-hover/section:opacity-100 group-hover/section:pointer-events-auto group-focus-within/section:opacity-100 group-focus-within/section:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mariner-200 active:scale-[0.96]"
                    >
                      {sectionActionLabel}
                    </button>
                  )}
                  <PromptPreview body={section.body} />
                </div>
              ))}
            </div>
            )}
          </div>

          {!disabled && !missingVersion && !versionLoading && (
            <div className="flex shrink-0 items-center gap-2 border-t border-neutral-200 bg-off-white px-3 py-2">
              <button type="button" onClick={copyWhole} className={secondaryBtn} title="Insert an editable snapshot">
                Copy text
              </button>
              <button
                type="button"
                onClick={() => insertReference(selectedVersion ?? activeRow.currentVersion)}
                className={secondaryBtn}
                title={`Always use version ${selectedVersion ?? activeRow.currentVersion}`}
              >
                Pin v{selectedVersion ?? activeRow.currentVersion}
              </button>
              <button
                type="button"
                onClick={() => insertReference("latest")}
                className={primaryBtn}
                title="Use the newest version for every new run"
              >
                Use latest
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-3 font-body text-[12px] text-neutral-400">
          Select a prompt.
        </div>
      )}
    </div>
  );
}
