"use client";

import { useRef, useState } from "react";
import { CkCard, CkTabs } from "@/components/ui";
import { PromptPreview } from "@/components/cockpit/prompt-library/prompt-preview";
import { VariableChips } from "@/components/cockpit/prompt-library/variable-chips";

export interface PromptDraft {
  name: string;
  description: string;
  tags: string[];
  body: string;
}

function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t) => b.includes(t));
}

const labelClass = "font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500";
const inputClass =
  "w-full border border-neutral-200 bg-panel rounded-[3px] px-2 py-1.5 font-body text-[13px] text-neutral-900";

export function PromptEditorForm({
  mode,
  initialName,
  initialDescription,
  initialTags,
  initialBody,
  currentVersion,
  busy,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "edit";
  initialName: string;
  initialDescription: string;
  initialTags: string[];
  initialBody: string;
  currentVersion: number;
  busy: boolean;
  onSubmit: (draft: PromptDraft) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [tags, setTags] = useState<string[]>(initialTags);
  const [tagInput, setTagInput] = useState("");
  const [body, setBody] = useState(initialBody);
  const [bodyTab, setBodyTab] = useState<"write" | "preview">("write");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const bodyChanged = body !== initialBody;
  const dirty =
    name !== initialName ||
    // Compare trimmed so a whitespace-only description (which saveEdit trims to
    // null) does not enable a Save that would silently no-op.
    description.trim() !== initialDescription.trim() ||
    !sameTags(tags, initialTags) ||
    // Uncommitted tag text still counts: submit() flushes it before saving.
    tagInput.trim() !== "" ||
    bodyChanged;
  const submitDisabled =
    busy ||
    !name.trim() ||
    (mode === "create" ? !body.trim() : !dirty);

  function commitTag() {
    const t = tagInput.trim().replace(/,+$/, "").trim();
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagInput("");
  }

  function submit() {
    if (submitDisabled) return;
    // Flush any tag text still sitting in the input so it is not lost on save.
    const pending = tagInput.trim().replace(/,+$/, "").trim();
    const finalTags = pending && !tags.includes(pending) ? [...tags, pending] : tags;
    if (pending) setTagInput("");
    onSubmit({ name: name.trim(), description, tags: finalTags, body });
  }

  function handleCancel() {
    if (dirty) setConfirmDiscard(true);
    else onCancel();
  }

  // setRangeText mutates the DOM value directly; the dispatched input event lets
  // React's controlled-input tracker pick up the change and keep the caret.
  function insertToken(token: string) {
    const el = bodyRef.current;
    if (!el) {
      setBody((b) => b + token);
      return;
    }
    el.focus();
    el.setRangeText(token, el.selectionStart, el.selectionEnd, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  const chars = body.length;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        }
      }}
      className="flex flex-col gap-3 lg:h-full min-w-0"
    >
      <CkCard
        eyebrow={mode === "create" ? "New prompt" : `Edit · v${currentVersion}`}
        title={mode === "create" ? "Create prompt" : name || "Untitled prompt"}
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className={labelClass} htmlFor="pl-name">
              Name
            </label>
            <input
              id="pl-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className={labelClass} htmlFor="pl-description">
              Description
            </label>
            <textarea
              id="pl-description"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={`${inputClass} resize-y`}
            />
          </div>

          <div className="flex flex-col gap-1">
            <span className={labelClass}>Tags</span>
            <div className="flex items-center gap-1.5 flex-wrap border border-neutral-200 bg-panel rounded-[3px] px-2 py-1.5">
              {tags.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-1 rounded-pill border border-neutral-200 bg-app-bg px-2 py-0.5 font-mono text-[10px] text-neutral-800"
                >
                  {t}
                  <button
                    type="button"
                    aria-label={`Remove ${t}`}
                    onClick={() => setTags(tags.filter((x) => x !== t))}
                    className="appearance-none border-none bg-transparent cursor-pointer text-neutral-500 hover:text-coal"
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onBlur={commitTag}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    commitTag();
                  } else if (e.key === "Backspace" && tagInput === "" && tags.length > 0) {
                    setTags(tags.slice(0, -1));
                  }
                }}
                placeholder="Add tag"
                aria-label="Add tag"
                className="flex-1 min-w-[80px] appearance-none border-none bg-transparent outline-none font-body text-[12px] text-neutral-900"
              />
            </div>
          </div>
        </div>
      </CkCard>

      <CkCard
        eyebrow="Prompt body"
        action={
          <CkTabs
            tabs={[
              { id: "write", label: "Write" },
              { id: "preview", label: "Preview" },
            ]}
            active={bodyTab}
            onChange={(id) => setBodyTab(id as "write" | "preview")}
          />
        }
      >
        {bodyTab === "write" ? (
          <div className="flex flex-col gap-2">
            <textarea
              ref={bodyRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write the prompt body. Use {{variable}} tokens for dynamic values."
              className="w-full min-h-[360px] resize-y border border-neutral-200 bg-panel rounded-[3px] px-3 py-2 font-mono text-[12px] leading-[1.55] text-neutral-900"
            />
            <VariableChips body={body} onInsertToken={insertToken} disabled={busy} />
            <div className="font-mono text-[9px] text-neutral-500">
              {chars} chars · ~{Math.ceil(chars / 4)} tokens
            </div>
          </div>
        ) : (
          <div className="border border-neutral-200 rounded-xs overflow-hidden">
            <div className="py-3 px-1">
              <PromptPreview body={body} maxHeightClass="max-h-[420px]" />
            </div>
          </div>
        )}
      </CkCard>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="submit"
          disabled={submitDisabled}
          className="appearance-none cursor-pointer border border-mariner bg-mariner text-white py-1.5 px-3.5 rounded-[3px] font-mono text-[11px] tracking-[0.04em] uppercase disabled:opacity-40 disabled:cursor-default"
        >
          {busy
            ? "Saving…"
            : mode === "create"
              ? "Create prompt"
              : `Save as v${currentVersion + 1}`}
        </button>
        {confirmDiscard ? (
          <span className="flex items-center gap-3 font-body text-[12px] text-neutral-700">
            <span>Discard draft?</span>
            <button
              type="button"
              onClick={onCancel}
              className="appearance-none border-none bg-transparent font-body text-[12px] font-semibold text-red-600 cursor-pointer"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={() => setConfirmDiscard(false)}
              className="appearance-none border-none bg-transparent font-body text-[12px] text-neutral-500 cursor-pointer"
            >
              Keep editing
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={handleCancel}
            className="appearance-none border-none bg-transparent font-body text-[12px] text-neutral-500 cursor-pointer"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
