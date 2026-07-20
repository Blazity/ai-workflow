import React from "react";
import type { PromptInspectorSummary } from "@/lib/prompt-library/prompt-inspector-summary";

export function PromptInspectorCard({
  label,
  disabled,
  summary,
  onOpen,
}: {
  label: string;
  disabled: boolean;
  summary: PromptInspectorSummary;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-label={`${disabled ? "View" : "Edit"} ${label}`}
      onClick={onOpen}
      className="group w-full rounded-[3px] border border-neutral-200 bg-off-white p-2.5 text-left hover:border-mariner-200 hover:bg-mariner-100"
    >
      <span className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[11px] font-semibold text-coal">{summary.title}</span>
          <span className="mt-0.5 block font-mono text-[9px] uppercase text-neutral-500">{summary.detail}</span>
        </span>
        <span className="font-mono text-[9px] uppercase text-mariner">
          {disabled ? "View prompt" : "Edit prompt"}
        </span>
      </span>
      {summary.preview && (
        <span className="mt-2 line-clamp-2 block font-body text-[11px] leading-[1.45] text-neutral-600">
          {summary.preview}
        </span>
      )}
    </button>
  );
}
