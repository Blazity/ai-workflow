"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  formatPromptReferenceToken,
  type PromptLibraryEntryMeta,
  type PromptSlotDefinition,
  type WorkflowAvailableValue,
} from "@shared/contracts";
import {
  PromptEditor,
  type PromptEditorSlotOption,
} from "@/components/cockpit/prompt-editor/prompt-editor";
import { PromptSectionComposer } from "@/components/cockpit/prompt-editor/prompt-section-composer";
import {
  PromptSlotDefinitionsEditor,
  type PromptSlotSchemaDraftState,
} from "@/components/cockpit/prompt-editor/prompt-slot-fields";
import { TagChipsInput } from "@/components/cockpit/prompt-library/tag-chips-input";
import { useEnterExit } from "@/lib/use-enter-exit";
import { PromptLibraryRail } from "./prompt-library-rail";
import { PromptSavePopover } from "./prompt-save-popover";
import type { PromptInsertPayload } from "./prompt-insert-popup";
import {
  DIALOG_FOCUSABLE_SELECTOR,
  initialDialogFocusTarget,
  promptEditorModalCapabilities,
  promptEditorSurface,
  trappedDialogTabTarget,
} from "@/lib/prompt-library/prompt-editor-modal-contract";
import type { PromptPreviewRequest, PromptPreviewTarget } from "@/lib/prompt-library/reference-navigation";

const headBtn =
  "appearance-none cursor-pointer inline-flex items-center gap-1 border border-neutral-200 bg-panel text-coal py-1 px-2 rounded-[3px] font-mono text-[10px] tracking-[0.04em] uppercase transition-[background-color,color,transform] duration-150 ease-standard hover:bg-app-bg active:scale-[0.96]";
const headBtnActive = "border-mariner-200 bg-mariner-100 text-mariner";
const primaryHeadBtn =
  "appearance-none cursor-pointer inline-flex items-center gap-1 border border-mariner bg-mariner text-white py-1 px-2.5 rounded-[3px] font-mono text-[10px] tracking-[0.04em] uppercase transition-transform duration-150 ease-standard active:scale-[0.96] disabled:opacity-40 disabled:cursor-default";
const metaLabelCls = "font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500";
const metaInputCls =
  "w-full border border-neutral-200 bg-panel rounded-[3px] px-2 py-1.5 font-body text-[13px] text-neutral-900 outline-none focus:border-mariner";

export interface PromptEditorModalMeta {
  name: string;
  description: string;
  tags: string[];
}

/** Library mode: the modal is the library's prompt editor. It gains a meta
 *  strip (name/description/tags), a primary save action, a dirty-guarded
 *  close, and hides "Save to library" (the prompt already lives there). */
export interface PromptEditorModalLibraryProps {
  meta: PromptEditorModalMeta;
  onMetaChange: (meta: PromptEditorModalMeta) => void;
  primaryLabel: string;
  primaryDisabled: boolean;
  primaryBusy: boolean;
  onPrimary: () => void;
  /** Unsaved changes: closing asks for confirmation first. */
  dirty: boolean;
  /** Save error surfaced inside the modal (the page banner sits behind it). */
  error?: string | null;
  /** The edited prompt's id, hidden from the rail (self-reference = cycle). */
  excludeId?: number;
  slots: PromptSlotDefinition[];
  onSlotsChange: (slots: PromptSlotDefinition[]) => void;
  onSlotRename?: (currentName: string, nextName: string) => void;
  onSlotSchemaDraftStateChange?: (
    state: PromptSlotSchemaDraftState,
  ) => void;
}

/**
 * Large "all-in" editor for a prompt body: the full WYSIWYG editor with an
 * optional library panel that slides in from the left (one modal, never a
 * modal-on-modal). Edits flow live through `onChange`; `onInsert` applies a
 * library payload (replace/append + provenance). Field mode edits a workflow
 * block's param; `library` mode turns it into the prompt library's editor.
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
  library,
  authoringMode = "v1",
  availableValues = [],
  slots = [],
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
  library?: PromptEditorModalLibraryProps;
  authoringMode?: "v1" | "v2";
  availableValues?: readonly WorkflowAvailableValue[];
  slots?: readonly PromptEditorSlotOption[];
}) {
  const { mounted, state } = useEnterExit(open, 180);
  const [libOpen, setLibOpen] = useState(!library);
  const [saveOpen, setSaveOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [syncRequest, setSyncRequest] = useState<{ id: number; mode: "replace" | "append" } | null>(null);
  const [previewRequest, setPreviewRequest] = useState<PromptPreviewRequest | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const syncRequestId = useRef(0);
  const previewRequestId = useRef(0);
  const handledInitialPreview = useRef(false);
  const onCloseRef = useRef(onClose);
  const libraryDirtyRef = useRef(false);
  const closeSave = useCallback(() => setSaveOpen(false), []);
  onCloseRef.current = onClose;
  libraryDirtyRef.current = library?.dirty ?? false;
  const hasContent = value.trim().length > 0;
  const editorSurface = promptEditorSurface(authoringMode);
  const { canEdit, canInsert, canSave } = promptEditorModalCapabilities(
    disabled,
    hasContent,
    library ? "library" : "field",
  );

  // Every close path (button, backdrop, Escape) funnels through here so a
  // dirty library draft always gets its confirmation.
  const attemptClose = useCallback(() => {
    if (libraryDirtyRef.current) setConfirmDiscard(true);
    else onCloseRef.current();
  }, []);

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

  // After "Save to library" the field's text lives in the library, so the
  // field itself switches to a live reference immediately: one source of truth
  // instead of an instantly-drifting copy. V2 always pins the saved version.
  const replaceWithSavedReference = useCallback(
    (meta: PromptLibraryEntryMeta) => {
      handleLibraryInsert({
        text: formatPromptReferenceToken({
          slug: meta.slug,
          version:
            authoringMode === "v2" ? meta.currentVersion : "latest",
        }),
        ref: null,
        mode: "replace",
      });
      closeSave();
    },
    [authoringMode, closeSave, handleLibraryInsert],
  );

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
      setConfirmDiscard(false);
      handledInitialPreview.current = false;
      return;
    }
    if (initialPreviewTarget && !handledInitialPreview.current) {
      handledInitialPreview.current = true;
      previewReference(initialPreviewTarget);
    }
  }, [initialPreviewTarget, open, previewReference]);

  // Field mode opens with the rail visible (inserting is the common intent);
  // library mode starts with it closed so the edited prompt is unmistakably
  // the only thing on screen until the user asks for the insert panel.
  const isLibrary = library !== undefined;
  useEffect(() => {
    if (open) setLibOpen(!isLibrary);
  }, [open, isLibrary]);

  // Escape yields to the save popover (it closes itself first); otherwise it
  // closes the library rail, then the whole modal. This listener may refresh as
  // transient state changes because its cleanup has no focus side effects.
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || saveOpen) return;
      // Nested popovers (variable picker, editor context menu, reference
      // actions menu) registered their window capture listeners after this
      // one, so they only see Escape if we yield here while one is open.
      if (document.querySelector('[role="menu"], [role="listbox"]')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (libOpen) setLibOpen(false);
      else attemptClose();
    };
    window.addEventListener("keydown", onEsc, { capture: true });
    return () => window.removeEventListener("keydown", onEsc, { capture: true });
  }, [attemptClose, open, libOpen, saveOpen]);

  if (!mounted) return null;
  return createPortal(
    <div
      role="presentation"
      onMouseDown={attemptClose}
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
            {library && (
              <button
                type="button"
                onClick={library.onPrimary}
                disabled={library.primaryDisabled}
                className={primaryHeadBtn}
              >
                {library.primaryBusy ? "Saving…" : library.primaryLabel}
              </button>
            )}
            <button type="button" data-dialog-initial-focus onClick={attemptClose} className={headBtn}>
              Close
            </button>
          </div>
        </div>

        {confirmDiscard && (
          <div className="flex shrink-0 items-center gap-3 border-b border-yellow-300 bg-[#FFF9E6] px-4 py-2 font-body text-[12px] text-neutral-700">
            <span>Discard draft?</span>
            <button
              type="button"
              onClick={() => {
                setConfirmDiscard(false);
                onCloseRef.current();
              }}
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
          </div>
        )}

        {library && (
          <div className="flex shrink-0 flex-col gap-2 border-b border-neutral-200 bg-off-white/60 px-4 py-3">
            <div className="flex flex-wrap items-start gap-3">
              <div className="flex min-w-[200px] flex-1 flex-col gap-1">
                <label className={metaLabelCls} htmlFor="pl-modal-name">
                  Name
                </label>
                <input
                  id="pl-modal-name"
                  value={library.meta.name}
                  disabled={!canEdit}
                  onChange={(e) => library.onMetaChange({ ...library.meta, name: e.target.value })}
                  className={metaInputCls}
                />
              </div>
              <div className="flex min-w-[200px] flex-1 flex-col gap-1">
                <span className={metaLabelCls}>Tags</span>
                <TagChipsInput
                  tags={library.meta.tags}
                  disabled={!canEdit}
                  onChange={(tags) => library.onMetaChange({ ...library.meta, tags })}
                />
              </div>
              <div className="flex min-w-[240px] flex-[1.4] flex-col gap-1">
                <label className={metaLabelCls} htmlFor="pl-modal-description">
                  Description
                </label>
                <input
                  id="pl-modal-description"
                  value={library.meta.description}
                  disabled={!canEdit}
                  onChange={(e) => library.onMetaChange({ ...library.meta, description: e.target.value })}
                  className={metaInputCls}
                />
              </div>
            </div>
            <PromptSlotDefinitionsEditor
              slots={library.slots}
              disabled={!canEdit}
              onChange={library.onSlotsChange}
              onRename={library.onSlotRename}
              onSchemaDraftStateChange={
                library.onSlotSchemaDraftStateChange
              }
            />
            {library.error && <div className="font-body text-[11px] text-red-600">{library.error}</div>}
          </div>
        )}

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
                excludeId={library?.excludeId}
                autoSelectFirst={!library}
                pinReferences={authoringMode === "v2"}
              />
            </div>
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 p-4">
            {editorSurface === "continuous" ? (
              <PromptEditor
                value={value}
                onChange={onChange}
                disabled={!canEdit}
                syncRequest={syncRequest}
                authoringMode="v2"
                availableValues={availableValues}
                slots={library?.slots ?? slots}
                fill
              />
            ) : (
              <PromptSectionComposer
                value={value}
                onChange={onChange}
                disabled={!canEdit}
                syncRequest={syncRequest}
              />
            )}
          </div>
        </div>
      </div>

      {canEdit && !library && (
        <PromptSavePopover
          open={saveOpen}
          onClose={closeSave}
          initialBody={value}
          onSaved={replaceWithSavedReference}
        />
      )}
    </div>,
    document.body,
  );
}
