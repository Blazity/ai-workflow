"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PromptSectionComposer } from "@/components/cockpit/prompt-editor/prompt-section-composer";
import { useEnterExit } from "@/lib/use-enter-exit";
import { PromptLibraryRail } from "./prompt-library-rail";
import { PromptSavePopover } from "./prompt-save-popover";
import type { PromptInsertPayload } from "./prompt-insert-popup";
import {
  DIALOG_FOCUSABLE_SELECTOR,
  initialDialogFocusTarget,
  promptEditorModalCapabilities,
  trappedDialogTabTarget,
} from "@/lib/prompt-library/prompt-editor-modal-contract";
import type { PromptPreviewRequest, PromptPreviewTarget } from "@/lib/prompt-library/reference-navigation";

const headBtn =
  "appearance-none cursor-pointer inline-flex items-center gap-1 border border-neutral-200 bg-panel text-coal py-1 px-2 rounded-[3px] font-mono text-[10px] tracking-[0.04em] uppercase transition-[background-color,color,transform] duration-150 ease-standard hover:bg-app-bg active:scale-[0.96]";
const headBtnActive = "border-mariner-200 bg-mariner-100 text-mariner";

/**
 * Large "all-in" editor for a block's prompt field: the full WYSIWYG editor with
 * an optional library panel that slides in from the left (one modal, never a
 * modal-on-modal). Edits flow live through `onChange`; `onInsert` applies a
 * library payload (replace/append + provenance).
 */
export function PromptEditorModal({
  open,
  disabled,
  onClose,
  value,
  onChange,
  onInsert,
  blockName,
  fieldLabel,
  initialPreviewTarget,
}: {
  open: boolean;
  disabled: boolean;
  onClose: () => void;
  value: string;
  onChange: (markdown: string) => void;
  onInsert: (payload: PromptInsertPayload) => void;
  blockName: string;
  fieldLabel: string;
  initialPreviewTarget?: PromptPreviewTarget | null;
}) {
  const { mounted, state } = useEnterExit(open, 180);
  const [libOpen, setLibOpen] = useState(true);
  const [saveOpen, setSaveOpen] = useState(false);
  const [syncRequest, setSyncRequest] = useState<{ id: number; mode: "replace" | "append" } | null>(null);
  const [previewRequest, setPreviewRequest] = useState<PromptPreviewRequest | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const syncRequestId = useRef(0);
  const previewRequestId = useRef(0);
  const handledInitialPreview = useRef(false);
  const onCloseRef = useRef(onClose);
  const closeSave = useCallback(() => setSaveOpen(false), []);
  onCloseRef.current = onClose;
  const hasContent = value.trim().length > 0;
  const { canEdit, canInsert, canSave } = promptEditorModalCapabilities(disabled, hasContent);

  const handleLibraryInsert = useCallback(
    (payload: PromptInsertPayload) => {
      if (!canInsert) return;
      onInsert(payload);
      syncRequestId.current += 1;
      setSyncRequest({ id: syncRequestId.current, mode: payload.mode });
    },
    [canInsert, onInsert],
  );

  const previewReference = useCallback((target: PromptPreviewTarget) => {
    previewRequestId.current += 1;
    setLibOpen(true);
    setPreviewRequest({ ...target, requestId: previewRequestId.current });
  }, []);

  // Modal lifetime owns scroll locking and focus restoration. Keep this separate
  // from transient rail/popover state so typing never runs the cleanup and sends
  // focus back to the page behind the dialog.
  useEffect(() => {
    if (!open) return;
    restoreFocus.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR));
      const preferred = dialog.querySelector<HTMLElement>("[data-dialog-initial-focus]");
      initialDialogFocusTarget(preferred, focusable, dialog).focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = prevOverflow;
      restoreFocus.current?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open || saveOpen) return;
    const onTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const target = trappedDialogTabTarget(focusable, document.activeElement as HTMLElement | null, event.shiftKey);
      if (!target) return;
      event.preventDefault();
      target.focus();
    };
    window.addEventListener("keydown", onTab, { capture: true });
    return () => window.removeEventListener("keydown", onTab, { capture: true });
  }, [open, saveOpen]);

  useEffect(() => {
    if (!open) {
      setSyncRequest(null);
      setPreviewRequest(null);
      handledInitialPreview.current = false;
      return;
    }
    if (initialPreviewTarget && !handledInitialPreview.current) {
      handledInitialPreview.current = true;
      previewReference(initialPreviewTarget);
    }
  }, [initialPreviewTarget, open, previewReference]);

  useEffect(() => {
    if (open) setLibOpen(true);
  }, [open]);

  // Escape yields to the save popover (it closes itself first); otherwise it
  // closes the library rail, then the whole modal. This listener may refresh as
  // transient state changes because its cleanup has no focus side effects.
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || saveOpen) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (libOpen) setLibOpen(false);
      else onCloseRef.current();
    };
    window.addEventListener("keydown", onEsc, { capture: true });
    return () => window.removeEventListener("keydown", onEsc, { capture: true });
  }, [open, libOpen, saveOpen]);

  if (!mounted) return null;
  return createPortal(
    <div
      role="presentation"
      onMouseDown={onClose}
      data-state={state}
      className={`fixed inset-0 z-[100] flex items-start justify-center px-[3vw] pt-[5vh] bg-coal/50 backdrop-blur-[2px] transition-opacity duration-200 ease-standard motion-reduce:transition-none ${
        state === "open" ? "opacity-100" : "opacity-0"
      }`}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${disabled ? "View" : "Edit"} ${fieldLabel}`}
        tabIndex={-1}
        data-state={state}
        onMouseDown={(e) => e.stopPropagation()}
        className={`flex h-[90vh] max-h-[90vh] w-[94vw] max-w-[1240px] flex-col overflow-hidden rounded-md bg-panel shadow-[0_24px_64px_-16px_rgba(24,27,32,0.45)] origin-top transition-[opacity,transform] duration-200 ease-standard motion-reduce:transition-none motion-reduce:transform-none ${
          state === "open" ? "opacity-100 translate-y-0 scale-100" : "opacity-0 -translate-y-2 scale-[0.98]"
        }`}
      >
        <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-neutral-200 px-4">
          <span className="truncate font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
            {blockName} · {fieldLabel}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              aria-pressed={libOpen}
              onClick={() => setLibOpen((o) => !o)}
              className={`${headBtn} ${libOpen ? headBtnActive : "text-mariner"}`}
            >
              ❡ Library
            </button>
            {canSave && (
              <button type="button" aria-haspopup="dialog" onClick={() => setSaveOpen(true)} className={headBtn}>
                ↥ Save
              </button>
            )}
            <button type="button" data-dialog-initial-focus onClick={onClose} className={headBtn}>
              Close
            </button>
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1">
          {/* Library rail — slides in by animating width, editor stays put. */}
          <div
            className={`min-h-0 min-w-0 shrink-0 overflow-hidden transition-[width] duration-200 ease-standard motion-reduce:transition-none ${
              libOpen ? "w-[40%] border-r border-neutral-200" : "w-0"
            }`}
          >
            <div className="h-full w-full min-w-0">
              <PromptLibraryRail
                disabled={!canInsert}
                onInsert={handleLibraryInsert}
                targetHasContent={hasContent}
                previewRequest={previewRequest}
              />
            </div>
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 p-4">
            <PromptSectionComposer
              value={value}
              onChange={onChange}
              disabled={!canEdit}
              syncRequest={syncRequest}
              onPreviewReference={previewReference}
            />
          </div>
        </div>
      </div>

      {canEdit && (
        <PromptSavePopover open={saveOpen} onClose={closeSave} initialBody={value} onSaved={closeSave} />
      )}
    </div>,
    document.body,
  );
}
