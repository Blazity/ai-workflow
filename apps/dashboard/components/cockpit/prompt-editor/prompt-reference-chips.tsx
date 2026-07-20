"use client";

import { useMemo, useState } from "react";
import {
  formatPromptReferenceToken,
  parsePromptReferenceTokens,
  type ParsedPromptReference,
  type PromptLibraryDetailResponse,
} from "@shared/contracts";
import { usePromptLibrary } from "@/components/cockpit/flow-editor/prompt-library-context";

const actionClass =
  "appearance-none cursor-pointer border-none bg-transparent p-0 font-mono text-[9px] uppercase tracking-[0.04em] text-mariner hover:underline disabled:cursor-default disabled:opacity-40";

export function PromptReferenceChips({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const { rows } = usePromptLibrary();
  const references = useMemo(() => parsePromptReferenceTokens(value), [value]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);

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
        return (
          <div
            key={key}
            className={`inline-flex min-w-0 items-center gap-1.5 rounded-[3px] border px-2 py-1 ${
              row ? "border-mariner-200 bg-mariner-100" : "border-yellow-300 bg-[#FFF4CC]"
            }`}
          >
            <span className="max-w-[180px] truncate font-mono text-[10px] font-semibold text-neutral-800">
              ❡ {row?.name ?? `Missing prompt ${reference.promptId}`}
            </span>
            <span className="font-mono text-[9px] text-neutral-500">
              {latest ? `Latest${row ? ` · v${row.currentVersion}` : ""}` : `Pinned v${reference.version}`}
            </span>
            {!disabled && row && latest && (
              <button
                type="button"
                className={actionClass}
                onClick={() => replaceAt(reference, formatPromptReferenceToken({ promptId: reference.promptId, version: row.currentVersion }))}
              >
                Pin
              </button>
            )}
            {!disabled && row && !latest && (
              <button
                type="button"
                className={actionClass}
                onClick={() => replaceAt(reference, formatPromptReferenceToken({ promptId: reference.promptId, version: "latest" }))}
              >
                Follow latest
              </button>
            )}
            {!disabled && row && (
              <button
                type="button"
                disabled={busyKey === key}
                className={actionClass}
                onClick={() => void detach(reference, key)}
              >
                {busyKey === key ? "Detaching…" : "Detach"}
              </button>
            )}
            {errorKey === key && <span className="font-mono text-[9px] text-red-700">Could not resolve</span>}
            <span className="sr-only">Reference {index + 1}</span>
          </div>
        );
      })}
    </div>
  );
}
