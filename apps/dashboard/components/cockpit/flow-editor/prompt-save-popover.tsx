"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PromptLibraryDetailResponse, PromptLibraryEntryMeta } from "@shared/contracts";
import { readErrorMessage } from "@/lib/api/error-message";
import {
  DIALOG_FOCUSABLE_SELECTOR,
  trappedDialogTabTarget,
} from "@/lib/prompt-library/prompt-editor-modal-contract";
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
  const [mounted, setMounted] = useState(false);
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  useEffect(() => setMounted(true), []);

  // On open: capture the previously focused element, seed the fields from the
  // current selection/body, lock body scroll, focus the name input, and dismiss on
  // Escape (capture + stopImmediatePropagation so the editor's own window Escape
  // handlers stay quiet, matching the insert popup). Restore focus to the opener on close.
  useEffect(() => {
    if (!open) return;
    restoreFocus.current = document.activeElement as HTMLElement | null;
    setName("");
    setTags("");
    setError(null);
    setBusy(false);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const raf = requestAnimationFrame(() => nameRef.current?.focus());
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    // The editor modal suspends its own Tab trap while this dialog is open
    // (aria-modal without a trap would let Tab walk the suspended modal), so
    // trap focus here with the same helper.
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR));
      const target = trappedDialogTabTarget(focusable, document.activeElement as HTMLElement | null, e.shiftKey);
      if (!target) return;
      e.preventDefault();
      target.focus();
    };
    window.addEventListener("keydown", onEsc, { capture: true });
    window.addEventListener("keydown", onTab, { capture: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onEsc, { capture: true });
      window.removeEventListener("keydown", onTab, { capture: true });
      document.body.style.overflow = prevOverflow;
      restoreFocus.current?.focus?.();
    };
  }, [open, initialBody, onClose]);

  if (!mounted || !open) return null;

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
      const res = await fetch("/api/prompt-library", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          body: initialBody,
          tags: parsedTags.length > 0 ? parsedTags : undefined,
        }),
      });
      if (!res.ok) {
        setError(await readErrorMessage(res));
        return;
      }
      const json = (await res.json()) as PromptLibraryDetailResponse;
      onSaved(json.meta);
      refresh();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save prompt");
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
      role="presentation"
      onMouseDown={(event) => {
        // The popover portals to document.body but sits inside the editor
        // modal's backdrop in the React tree; without stopPropagation this
        // mousedown would bubble there and close both dialogs at once.
        event.stopPropagation();
        onClose();
      }}
      className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[12vh] bg-coal/50 backdrop-blur-[2px]"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Save to library"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex w-full max-w-[560px] flex-col gap-3 overflow-hidden rounded-md bg-panel p-4 shadow-[0_24px_64px_-16px_rgba(24,27,32,0.45)] animate-ck-pop motion-reduce:animate-none"
      >
        <div className="flex items-center gap-2">
          <h3 className="m-0 font-display text-[15px] font-semibold text-neutral-900">Save to library</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto appearance-none border-none bg-transparent cursor-pointer w-[22px] h-[22px] rounded-xs inline-flex items-center justify-center font-mono text-sm text-neutral-500 hover:bg-app-bg hover:text-coal"
          >
            ×
          </button>
        </div>

        <div className="flex flex-col gap-1">
          <label className={labelCls} htmlFor="pl-save-name">
            Name
          </label>
          <input
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
          <input
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
          <textarea
            id="pl-save-body"
            value={initialBody}
            readOnly
            aria-readonly="true"
            className="w-full min-h-[200px] max-h-[40vh] resize-y border border-neutral-200 bg-off-white rounded-[3px] px-3 py-2 font-mono text-[12px] leading-[1.55] text-neutral-600 outline-none cursor-default"
          />
        </div>

        {error && <div className="font-body text-[11px] text-red-600">{error}</div>}

        <div className="flex items-center gap-3">
          <button type="button" onClick={() => void save()} disabled={!canSave} className={primaryBtn}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button type="button" onClick={onClose} className={ghostBtn}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
