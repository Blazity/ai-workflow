"use client";

import { useEffect, useRef, useState } from "react";
import type { PromptLibraryEntryMeta } from "@shared/contracts";
import { apiClient } from "@/lib/api/client";
import { Button, IconButton, Input, Modal, Textarea } from "@/components/ui";
import { usePromptLibrary } from "./prompt-library-context";

const labelCls = "font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500";
const inputCls =
  "w-full border border-neutral-200 bg-panel rounded-[3px] px-2 py-1.5 font-body text-[13px] text-neutral-900 outline-none";
const primaryBtn =
  "appearance-none cursor-pointer border border-mariner bg-mariner text-white py-1.5 px-3.5 rounded-[3px] font-mono text-[11px] tracking-[0.04em] uppercase disabled:opacity-40 disabled:cursor-default";
const ghostBtn =
  "appearance-none border-none bg-transparent cursor-pointer font-body text-[12px] text-neutral-500";

/** Modal to lift a block field's text into a new library prompt. Posts to the
 *  dashboard proxy, refreshes the shared library so the new prompt is pickable,
 *  and hands the created row back to the caller. */
export function PromptSavePopover({
  open,
  onClose,
  initialBody,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  initialBody: string;
  onSaved: (meta: PromptLibraryEntryMeta) => void;
}) {
  const { refresh } = usePromptLibrary();
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setTags("");
    setError(null);
    setBusy(false);
  }, [open, initialBody]);

  const canSave = name.trim().length > 0 && initialBody.trim().length > 0 && !busy;

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    const parsedTags = tags
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    try {
      const res = await apiClient.prompts.create({
        name: name.trim(),
        body: initialBody,
        tags: parsedTags.length > 0 ? parsedTags : undefined,
      });
      if (!res.ok) {
        setError(res.errorMessage);
        return;
      }
      const json = res.data;
      onSaved(json.meta);
      refresh();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save prompt");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      chrome="none"
      aria-label="Save to library"
      variant="command"
      size="md"
      initialFocusRef={nameRef}
      frameClassName="!pt-[12vh] [&_[data-modal-overlay]]:bg-coal/50 [&_[data-modal-overlay]]:backdrop-blur-[2px]"
      className="flex w-full max-w-[560px] flex-col gap-3 overflow-hidden rounded-md border-0 bg-panel p-4 shadow-[0_24px_64px_-16px_rgba(24,27,32,0.45)]"
    >
      <div className="flex items-center gap-2">
        <h3 className="m-0 font-display text-[15px] font-semibold text-neutral-900">Save to library</h3>
        <IconButton
          aria-label="Close"
          variant="text"
          size="sm"
          onClick={onClose}
          className="ml-auto appearance-none border-none bg-transparent cursor-pointer w-[22px] h-[22px] rounded-xs inline-flex items-center justify-center font-mono text-sm text-neutral-500 hover:bg-app-bg hover:text-coal"
        >
          ×
        </IconButton>
      </div>

        <div className="flex flex-col gap-1">
          <label className={labelCls} htmlFor="pl-save-name">
            Name
          </label>
          <Input
            id="pl-save-name"
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputCls}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className={labelCls} htmlFor="pl-save-tags">
            Tags
          </label>
          <Input
            id="pl-save-tags"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="comma, separated"
            className={inputCls}
          />
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-baseline gap-2">
            <label className={labelCls} htmlFor="pl-save-body">
              Body
            </label>
            <span className="font-body text-[10px] text-neutral-400">read-only, edit in the prompt editor</span>
          </div>
          <Textarea
            id="pl-save-body"
            value={initialBody}
            readOnly
            aria-readonly="true"
            monospace
            className="w-full min-h-[200px] max-h-[40vh] resize-y border border-neutral-200 bg-off-white rounded-[3px] px-3 py-2 font-mono text-[12px] leading-[1.55] text-neutral-600 outline-none cursor-default"
          />
        </div>

        {error && <div className="font-body text-[11px] text-red-600">{error}</div>}

        <div className="flex items-center gap-3">
          <Button variant="text" onClick={() => void save()} disabled={!canSave} className={primaryBtn}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button variant="text" onClick={onClose} className={ghostBtn}>
            Cancel
          </Button>
        </div>
    </Modal>
  );
}
