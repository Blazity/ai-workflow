"use client";

import { useEffect, useRef, useState } from "react";
import type { PromptLibraryEntryMeta } from "@shared/contracts";
import { apiClient } from "@/lib/api/client";
import { Button, IconButton, Input, Modal, Textarea } from "@/components/ui";
import { usePromptLibrary } from "./prompt-library-context";

const labelCls = "font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500";

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
      title="Save to library"
      size="md"
      initialFocusRef={nameRef}
      footer={
        <div className="flex items-center gap-3">
          <Button onClick={() => void save()} disabled={!canSave}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <IconButton
        aria-label="Close"
        onClick={onClose}
        className="absolute right-4 top-3"
      >
        ×
      </IconButton>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label className={labelCls} htmlFor="pl-save-name">
            Name
          </label>
          <Input
            id="pl-save-name"
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
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
            className="min-h-[200px] max-h-[40vh] bg-off-white text-neutral-600 cursor-default"
          />
        </div>

        {error && <div className="font-body text-[11px] text-red-600">{error}</div>}
      </div>
    </Modal>
  );
}
