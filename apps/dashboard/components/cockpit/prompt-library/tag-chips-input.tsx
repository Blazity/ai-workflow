"use client";

import { useState } from "react";

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
    <div className="flex items-center gap-1.5 flex-wrap border border-neutral-200 bg-panel rounded-[3px] px-2 py-1.5">
      {tags.map((t) => (
        <span
          key={t}
          className="inline-flex items-center gap-1 rounded-pill border border-neutral-200 bg-app-bg px-2 py-0.5 font-mono text-[10px] text-neutral-800"
        >
          {t}
          <button
            type="button"
            disabled={disabled}
            aria-label={`Remove ${t}`}
            onClick={() => onChange(tags.filter((x) => x !== t))}
            className="appearance-none border-none bg-transparent cursor-pointer text-neutral-500 hover:text-coal disabled:cursor-default"
          >
            ×
          </button>
        </span>
      ))}
      <input
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
        className="flex-1 min-w-[80px] appearance-none border-none bg-transparent outline-none font-body text-[12px] text-neutral-900"
      />
    </div>
  );
}
