"use client";

import { useState } from "react";
import { IconButton, Input } from "@/components/ui";

/** Chip-style tag editor: Enter/comma/blur commits the typed tag, Backspace on
 *  an empty input removes the last chip. Extracted from the retired
 *  PromptEditorForm so the prompt editor modal can reuse it. */
export function TagChipsInput({
  tags,
  onChange,
  disabled,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
}) {
  const [tagInput, setTagInput] = useState("");

  function commitTag() {
    const t = tagInput.trim().replace(/,+$/, "").trim();
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setTagInput("");
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-[3px] border border-neutral-200 bg-panel px-2 py-1.5">
      {tags.map((t) => (
        <span
          key={t}
          className="inline-flex items-center gap-1 rounded-pill border border-neutral-200 bg-app-bg px-2 py-0.5 font-mono text-[10px] text-neutral-800"
        >
          {t}
          <IconButton
            variant="text"
            type="button"
            disabled={disabled}
            aria-label={`Remove ${t}`}
            onClick={() => onChange(tags.filter((x) => x !== t))}
            className="cursor-pointer bg-transparent text-neutral-500 hover:text-coal"
          >
            ×
          </IconButton>
        </span>
      ))}
      <Input
        size="sm"
        value={tagInput}
        disabled={disabled}
        onChange={(e) => setTagInput(e.target.value)}
        onBlur={commitTag}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commitTag();
          } else if (e.key === "Backspace" && tagInput === "" && tags.length > 0) {
            onChange(tags.slice(0, -1));
          }
        }}
        placeholder="Add tag"
        aria-label="Add tag"
        className="h-auto min-w-[80px] flex-1 appearance-none border-none bg-transparent p-0 text-neutral-900 outline-none hover:border-transparent focus-visible:ring-0 focus-visible:ring-offset-0"
      />
    </div>
  );
}
