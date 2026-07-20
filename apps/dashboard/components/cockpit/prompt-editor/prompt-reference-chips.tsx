"use client";

import Link from "next/link";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  formatPromptReferenceToken,
  parsePromptReferenceTokens,
  type ParsedPromptReference,
  type PromptLibraryDetailResponse,
  type PromptLibraryListRowDto,
} from "@shared/contracts";
import { usePromptLibrary } from "@/components/cockpit/flow-editor/prompt-library-context";
import {
  promptLibraryHref,
  promptReferenceCapabilities,
  type PromptPreviewTarget,
} from "@/lib/prompt-library/reference-navigation";

const actionClass =
  "appearance-none cursor-pointer border-none bg-transparent p-0 font-mono text-[9px] uppercase tracking-[0.04em] text-mariner hover:underline disabled:cursor-default disabled:opacity-40";

type PromptReferenceChipsProps = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  onPreview?: (target: PromptPreviewTarget) => void;
};

export function PromptReferenceChips(props: PromptReferenceChipsProps) {
  const { rows } = usePromptLibrary();
  return <PromptReferenceChipsView {...props} rows={rows} />;
}

export function PromptReferenceChipsView({
  value,
  onChange,
  disabled,
  onPreview,
  rows,
}: PromptReferenceChipsProps & { rows: readonly PromptLibraryListRowDto[] }) {
  const references = useMemo(() => parsePromptReferenceTokens(value), [value]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const menuRoot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuKey) return;
    const close = (event: MouseEvent) => {
      if (!menuRoot.current?.contains(event.target as Node)) setMenuKey(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuKey(null);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuKey]);

  if (references.length === 0) return null;

  const replaceAt = (reference: ParsedPromptReference, replacement: string) => {
    onChange(`${value.slice(0, reference.start)}${replacement}${value.slice(reference.end)}`);
  };

  const detach = async (reference: ParsedPromptReference, key: string) => {
    const row = rows.find((candidate) => candidate.id === reference.promptId);
    if (!row) {
      setErrorKey(key);
      return;
    }
    setBusyKey(key);
    setErrorKey(null);
    try {
      let body = row.body;
      if (reference.version !== "latest" && reference.version !== row.currentVersion) {
        const response = await fetch(`/api/prompt-library/${reference.promptId}`);
        if (!response.ok) throw new Error(String(response.status));
        const detail = (await response.json()) as PromptLibraryDetailResponse;
        const version = detail.versions.find((candidate) => candidate.version === reference.version);
        if (!version) throw new Error("missing version");
        body = version.body;
      }
      replaceAt(reference, body);
    } catch {
      setErrorKey(key);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Prompt references">
      {references.map((reference, index) => {
        const row = rows.find((candidate) => candidate.id === reference.promptId);
        const key = `${reference.start}-${reference.raw}`;
        const latest = reference.version === "latest";
        const capabilities = promptReferenceCapabilities(Boolean(row), Boolean(disabled));
        return (
          <div
            key={key}
            ref={menuKey === key ? menuRoot : undefined}
            className={`relative inline-flex min-w-0 items-center gap-1.5 rounded-[3px] border px-2 py-1 ${
              row ? "border-mariner-200 bg-mariner-100" : "border-yellow-300 bg-[#FFF4CC]"
            }`}
          >
            <span className="max-w-[180px] truncate font-mono text-[10px] font-semibold text-neutral-800">
              ❡ {row?.name ?? `Missing prompt ${reference.promptId}`}
            </span>
            <span className="font-mono text-[9px] text-neutral-500">
              {latest ? `Latest${row ? ` · v${row.currentVersion}` : ""}` : `Pinned v${reference.version}`}
            </span>
            {capabilities.canPreview && onPreview && (
              <button
                type="button"
                className={actionClass}
                onClick={() => onPreview({ promptId: reference.promptId, version: reference.version })}
              >
                Preview
              </button>
            )}
            {capabilities.canOpenLibrary && row && (
              <Link
                href={promptLibraryHref(reference.promptId)}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open ${row.name} in prompt library (new tab)`}
                className={actionClass}
              >
                Open in library ↗
              </Link>
            )}
            {capabilities.canMutate && row && (
              <button
                type="button"
                aria-label={`More actions for ${row.name}`}
                aria-haspopup="menu"
                aria-expanded={menuKey === key}
                className={`${actionClass} rounded-[3px] px-1 text-[12px] no-underline hover:bg-white/70 hover:no-underline`}
                onClick={() => setMenuKey((current) => current === key ? null : key)}
              >
                ···
              </button>
            )}
            {capabilities.canMutate && row && menuKey === key && (
              <div
                role="menu"
                className="absolute right-1 top-[calc(100%+4px)] z-20 min-w-[132px] rounded-[3px] border border-neutral-200 bg-panel p-1 shadow-[0_8px_24px_rgba(24,27,32,0.14)]"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="block w-full cursor-pointer rounded-[2px] px-2 py-1.5 text-left font-mono text-[10px] text-neutral-700 hover:bg-off-white"
                  onClick={() => {
                    replaceAt(reference, formatPromptReferenceToken({
                      promptId: reference.promptId,
                      version: latest ? row.currentVersion : "latest",
                    }));
                    setMenuKey(null);
                  }}
                >
                  {latest ? `Pin v${row.currentVersion}` : "Follow latest"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={busyKey === key}
                  className="block w-full cursor-pointer rounded-[2px] px-2 py-1.5 text-left font-mono text-[10px] text-red-700 hover:bg-red-50 disabled:cursor-default disabled:opacity-50"
                  onClick={() => {
                    setMenuKey(null);
                    void detach(reference, key);
                  }}
                >
                  {busyKey === key ? "Detaching…" : "Detach"}
                </button>
              </div>
            )}
            {errorKey === key && <span className="font-mono text-[9px] text-red-700">Could not resolve</span>}
            <span className="sr-only">Reference {index + 1}</span>
          </div>
        );
      })}
    </div>
  );
}
