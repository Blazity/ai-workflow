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
      className="group w-full cursor-pointer rounded-[3px] border border-neutral-200 bg-off-white p-2.5 text-left outline-none transition-[border-color,background-color,box-shadow] hover:border-mariner-200 hover:bg-mariner-100 focus-visible:border-mariner focus-visible:ring-2 focus-visible:ring-mariner-200"
    >
      <span className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[11px] font-semibold text-coal">{summary.title}</span>
          <span className="mt-0.5 block font-mono text-[9px] uppercase text-neutral-500">{summary.detail}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 font-mono text-[9px] uppercase text-mariner">
          {disabled ? "View prompt" : "Edit prompt"}
          <span aria-hidden="true">→</span>
        </span>
      </span>
      {summary.kind === "custom" && summary.sectionTitles.length > 0 && (
        <span className="mt-2 flex flex-wrap gap-1" aria-label="Prompt sections">
          {summary.sectionTitles.map((title) => (
            <span
              key={title}
              className="max-w-full truncate rounded-[3px] border border-neutral-200 bg-panel px-1.5 py-0.5 font-mono text-[9px] text-neutral-600"
            >
              {title}
            </span>
          ))}
          {summary.remainingSectionCount > 0 && (
            <span className="px-1 py-0.5 font-mono text-[9px] text-neutral-500">
              +{summary.remainingSectionCount} more
            </span>
          )}
        </span>
      )}
    </button>
  );
}
