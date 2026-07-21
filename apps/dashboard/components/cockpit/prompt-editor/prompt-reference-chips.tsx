"use client";

import Link from "next/link";
import React, { useMemo, useRef, useState } from "react";
import {
  formatPromptReferenceToken,
  parsePromptReferenceTokens,
  promptReferenceMatchesRow,
  promptReferenceTargetLabel,
  type ParsedPromptReference,
  type PromptLibraryDetailResponse,
  type PromptLibraryListRowDto,
} from "@shared/contracts";
import { usePromptLibrary } from "@/components/cockpit/flow-editor/prompt-library-context";
import { PromptPreview } from "@/components/cockpit/prompt-library/prompt-preview";
import {
  promptLibraryHref,
  promptReferenceCapabilities,
} from "@/lib/prompt-library/reference-navigation";
import { resolveReferencePreview } from "@/lib/prompt-library/reference-preview";
import { PromptReferenceActionsMenu } from "./prompt-reference-actions-menu";

const quietAction =
  "relative inline-flex min-h-10 cursor-pointer appearance-none items-center justify-center whitespace-nowrap rounded-[3px] border border-transparent bg-transparent px-2.5 font-mono text-[9px] uppercase tracking-[0.04em] text-mariner transition-[background-color,border-color,transform] duration-150 ease-standard hover:border-mariner-200 hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mariner-200 active:scale-[0.96]";

type PromptReferenceChipsProps = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
};

type MenuPosition = { left: number; top: number };

export function PromptReferenceChips(props: PromptReferenceChipsProps) {
  const { rows } = usePromptLibrary();
  return <PromptReferenceChipsView {...props} rows={rows} />;
}

export function PromptReferenceChipsView({
  value,
  onChange,
  disabled,
  rows,
}: PromptReferenceChipsProps & { rows: readonly PromptLibraryListRowDto[] }) {
  const references = useMemo(() => parsePromptReferenceTokens(value), [value]);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [detailCache, setDetailCache] = useState<Map<number, PromptLibraryDetailResponse>>(new Map());
  const [loadingIds, setLoadingIds] = useState<Set<number>>(new Set());
  const [detailErrorIds, setDetailErrorIds] = useState<Set<number>>(new Set());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const triggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const detailRequests = useRef<Map<number, Promise<PromptLibraryDetailResponse>>>(new Map());

  if (references.length === 0) return null;

  const replaceAt = (reference: ParsedPromptReference, replacement: string) => {
    onChange(`${value.slice(0, reference.start)}${replacement}${value.slice(reference.end)}`);
  };

  const loadDetail = (promptId: number): Promise<PromptLibraryDetailResponse> => {
    const cached = detailCache.get(promptId);
    if (cached) return Promise.resolve(cached);
    const pending = detailRequests.current.get(promptId);
    if (pending) return pending;

    setLoadingIds((current) => new Set(current).add(promptId));
    setDetailErrorIds((current) => {
      const next = new Set(current);
      next.delete(promptId);
      return next;
    });
    const request = fetch(`/api/prompt-library/${promptId}`)
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<PromptLibraryDetailResponse>;
      })
      .then((detail) => {
        setDetailCache((current) => new Map(current).set(promptId, detail));
        return detail;
      })
      .catch((error) => {
        setDetailErrorIds((current) => new Set(current).add(promptId));
        throw error;
      })
      .finally(() => {
        detailRequests.current.delete(promptId);
        setLoadingIds((current) => {
          const next = new Set(current);
          next.delete(promptId);
          return next;
        });
      });
    detailRequests.current.set(promptId, request);
    return request;
  };

  const toggleExpanded = (
    reference: ParsedPromptReference,
    row: PromptLibraryListRowDto,
    key: string,
  ) => {
    if (expandedKeys.has(key)) {
      setExpandedKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      return;
    }
    setExpandedKeys((current) => new Set(current).add(key));
    if (resolveReferencePreview(reference, row, detailCache.get(row.id)).kind === "needs-detail") {
      void loadDetail(row.id).catch(() => {});
    }
  };

  const detach = async (
    reference: ParsedPromptReference,
    row: PromptLibraryListRowDto,
    key: string,
  ) => {
    setBusyKey(key);
    setErrorKey(null);
    try {
      let resolution = resolveReferencePreview(reference, row, detailCache.get(row.id));
      if (resolution.kind === "needs-detail") {
        const detail = await loadDetail(row.id);
        resolution = resolveReferencePreview(reference, row, detail);
      }
      if (resolution.kind !== "ready") throw new Error("missing version");
      replaceAt(reference, resolution.body);
    } catch {
      setErrorKey(key);
    } finally {
      setBusyKey(null);
    }
  };

  const closeMenu = (restoreFocus: boolean) => {
    const trigger = menuKey ? triggerRefs.current.get(menuKey) : null;
    setMenuKey(null);
    if (restoreFocus) requestAnimationFrame(() => trigger?.focus());
  };

  return (
    <div className="flex w-full flex-col gap-2" aria-label="Prompt references">
      {references.map((reference, index) => {
        const row = rows.find((candidate) => promptReferenceMatchesRow(reference, candidate));
        const key = `${reference.start}-${reference.raw}`;
        const latest = reference.version === "latest";
        const capabilities = promptReferenceCapabilities(Boolean(row), Boolean(disabled));
        const expanded = expandedKeys.has(key);
        const resolution = row
          ? resolveReferencePreview(reference, row, detailCache.get(row.id))
          : null;
        const detailFailed = row ? detailErrorIds.has(row.id) : false;
        const loading = row ? loadingIds.has(row.id) : false;
        const trigger = triggerRefs.current.get(key) ?? null;

        return (
          <article
            key={key}
            className={`w-full min-w-0 overflow-hidden rounded-[5px] border bg-panel shadow-[0_2px_8px_rgba(24,27,32,0.05)] ${
              row ? "border-mariner-200" : "border-yellow-300"
            }`}
          >
            <div className={`flex min-w-0 items-center gap-2 px-3 py-2.5 ${row ? "bg-mariner-100/60" : "bg-[#FFF9E6]"}`}>
              <span
                className={`inline-flex size-7 shrink-0 items-center justify-center rounded-[3px] font-mono text-[12px] ${
                  row ? "bg-panel text-mariner shadow-[0_1px_3px_rgba(24,27,32,0.08)]" : "bg-[#FFF4CC] text-[#7A5A00]"
                }`}
                aria-hidden="true"
              >
                ❡
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[11px] font-semibold text-neutral-900">
                  {row?.name ?? `Missing prompt ${promptReferenceTargetLabel(reference)}`}
                </div>
                {row && (
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex h-5 items-center rounded-pill border border-mariner-200 bg-panel px-2 font-mono text-[8px] uppercase tracking-[0.05em] text-mariner">
                      Live reference
                    </span>
                    <span className="inline-flex h-5 items-center rounded-pill border border-neutral-200 bg-panel px-2 font-mono text-[9px] tabular-nums text-neutral-600">
                      {latest ? `Latest · v${row.currentVersion}` : `Pinned · v${reference.version}`}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {row && (
              <div className="flex min-h-10 flex-wrap items-center gap-1 border-t border-mariner-100 bg-off-white/70 px-2 py-1">
                {capabilities.canExpand && (
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => toggleExpanded(reference, row, key)}
                    className={quietAction}
                  >
                    <span aria-hidden="true" className="mr-1.5 text-[11px]">{expanded ? "−" : "+"}</span>
                    {expanded ? "Hide content" : "Show content"}
                  </button>
                )}
                {capabilities.canOpenLibrary && (
                  <Link
                    href={promptLibraryHref(row.slug)}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${row.name} in prompt library (new tab)`}
                    className={quietAction}
                  >
                    Open in library ↗
                  </Link>
                )}
                {capabilities.canMutate && (
                  <button
                    type="button"
                    disabled={busyKey === key}
                    onClick={() => void detach(reference, row, key)}
                    className={`${quietAction} disabled:cursor-default disabled:opacity-50`}
                  >
                    {busyKey === key ? "Detaching…" : "Detach and edit"}
                  </button>
                )}
                {capabilities.canMutate && (
                  <button
                    ref={(node) => {
                      if (node) triggerRefs.current.set(key, node);
                      else triggerRefs.current.delete(key);
                    }}
                    type="button"
                    aria-label={`More actions for ${row.name}`}
                    aria-haspopup="menu"
                    aria-expanded={menuKey === key}
                    onClick={(event) => {
                      if (menuKey === key) {
                        closeMenu(false);
                        return;
                      }
                      const rect = event.currentTarget.getBoundingClientRect();
                      const width = 184;
                      setMenuPosition({
                        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
                        top: Math.min(rect.bottom + 6, window.innerHeight - 112),
                      });
                      setMenuKey(key);
                    }}
                    className={`${quietAction} ml-auto w-9 px-0 text-[13px]`}
                  >
                    ···
                  </button>
                )}
              </div>
            )}

            {expanded && row && (
              <div className="border-t border-mariner-100 bg-[#F7FAFF] px-3 py-3 shadow-[inset_3px_0_0_#8CB4E8]">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-mariner">
                    Referenced content · read-only
                  </span>
                  <span className="font-mono text-[9px] tabular-nums text-neutral-500">
                    {latest ? `Latest · v${row.currentVersion}` : `Pinned · v${reference.version}`}
                  </span>
                </div>
                {resolution?.kind === "ready" ? (
                  <PromptPreview body={resolution.body} />
                ) : loading ? (
                  <div className="py-5 font-mono text-[10px] text-neutral-500">Loading referenced version…</div>
                ) : detailFailed ? (
                  <div className="flex flex-wrap items-center gap-2 py-3 font-body text-[12px] text-neutral-600">
                    Could not load this version.
                    <button
                      type="button"
                      className={quietAction}
                      onClick={() => void loadDetail(row.id).catch(() => {})}
                    >
                      Retry
                    </button>
                  </div>
                ) : (
                  <div className="py-5 font-body text-[12px] text-[#7A5A00]">
                    Version v{reference.version} is unavailable.
                  </div>
                )}
              </div>
            )}

            {errorKey === key && (
              <div className="border-t border-red-100 bg-red-50 px-3 py-2 font-mono text-[9px] text-red-700">
                Could not resolve this version.
              </div>
            )}
            <span className="sr-only">Reference {index + 1}</span>

            {capabilities.canMutate && row && (
              <PromptReferenceActionsMenu
                open={menuKey === key}
                position={menuKey === key ? menuPosition : null}
                trigger={trigger}
                primaryLabel={latest ? `Pin v${row.currentVersion}` : "Follow latest"}
                onPrimary={() => {
                  replaceAt(reference, formatPromptReferenceToken({
                    slug: row.slug,
                    version: latest ? row.currentVersion : "latest",
                  }));
                  closeMenu(true);
                }}
                onClose={closeMenu}
              />
            )}
          </article>
        );
      })}
    </div>
  );
}
