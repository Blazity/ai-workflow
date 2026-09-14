"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type PromptLibraryEntryMeta,
  type PromptSlotDefinition,
  type WorkflowDataCatalogEntry,
} from "@shared/contracts";
import { formatPromptReferenceToken } from "@shared/prompts";
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
import { Button, Input, Modal } from "@/components/ui";
import { PromptLibraryRail } from "./prompt-library-rail";
import { PromptSavePopover } from "./prompt-save-popover";
import type { PromptInsertPayload } from "./prompt-insert-popup";
import { promptEditorModalCapabilities, promptEditorSurface } from "@shared/prompts";
import type { PromptPreviewRequest, PromptPreviewTarget } from "@shared/prompts";

const headBtn =
  "appearance-none cursor-pointer inline-flex items-center gap-1 border border-neutral-200 bg-panel text-coal py-1 px-2 rounded-[3px] font-mono text-[10px] tracking-[0.04em] uppercase transition-[background-color,color,transform] duration-[var(--motion-fast)] ease-standard hover:bg-app-bg active:scale-[0.96]";
const headBtnActive = "border-mariner-200 bg-mariner-100 text-mariner";
const primaryHeadBtn =
  "appearance-none cursor-pointer inline-flex items-center gap-1 border border-mariner bg-mariner text-white py-1 px-2.5 rounded-[3px] font-mono text-[10px] tracking-[0.04em] uppercase transition-transform duration-[var(--motion-fast)] ease-standard active:scale-[0.96] disabled:opacity-40 disabled:cursor-default";
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
  availableValues?: readonly WorkflowDataCatalogEntry[];
  slots?: readonly PromptEditorSlotOption[];
}) {
  const [libOpen, setLibOpen] = useState(!library);
  const [saveOpen, setSaveOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [syncRequest, setSyncRequest] = useState<{ id: number; mode: "replace" | "append" } | null>(null);
  const [previewRequest, setPreviewRequest] = useState<PromptPreviewRequest | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
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
      if (e.key !== "Escape") return;
      if (saveOpen) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setSaveOpen(false);
        return;
      }
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

  return (
    <Modal
      open={open}
      onClose={attemptClose}
      chrome="none"
      aria-label={`${disabled ? "View" : "Edit"} ${fieldLabel}`}
      size="lg"
      frameClassName="!items-start !justify-center !px-[3vw] !pt-[5vh] !pb-0 [&_[data-modal-overlay]]:bg-coal/50 [&_[data-modal-overlay]]:backdrop-blur-[2px]"
      className="flex h-[90vh] max-h-[90vh] w-[94vw] max-w-[1240px] flex-col overflow-hidden rounded-md border-0 bg-panel shadow-[0_24px_64px_-16px_rgba(24,27,32,0.45)] origin-top"
    >
      <div ref={dialogRef} className="flex h-full min-h-0 flex-col">
        <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-neutral-200 px-4">
          <span className="truncate font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
            {blockName} · {fieldLabel}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="text"
              size="sm"
              aria-pressed={libOpen}
              onClick={() => setLibOpen((o) => !o)}
              className={`${headBtn} ${libOpen ? headBtnActive : "text-mariner"}`}
            >
              ❡ Library
            </Button>
            {canSave && (
              <Button type="button" variant="text" size="sm" aria-haspopup="dialog" onClick={() => setSaveOpen(true)} className={headBtn}>
                ↥ Save
              </Button>
            )}
            {library && (
              <Button
                type="button"
                variant="text"
                size="sm"
                onClick={library.onPrimary}
                disabled={library.primaryDisabled}
                className={primaryHeadBtn}
              >
                {library.primaryBusy ? "Saving…" : library.primaryLabel}
              </Button>
            )}
            <Button type="button" variant="text" size="sm" data-dialog-initial-focus onClick={attemptClose} className={headBtn}>
              Close
            </Button>
          </div>
        </div>

        {confirmDiscard && (
          <div className="flex shrink-0 items-center gap-3 border-b border-yellow-300 bg-[#FFF9E6] px-4 py-2 font-body text-[12px] text-neutral-700">
            <span>Discard draft?</span>
            <Button
              type="button"
              variant="text"
              size="sm"
              onClick={() => {
                setConfirmDiscard(false);
                onCloseRef.current();
              }}
              className="appearance-none border-none bg-transparent font-body text-[12px] font-semibold text-red-600 cursor-pointer"
            >
              Discard
            </Button>
            <Button
              type="button"
              variant="text"
              size="sm"
              onClick={() => setConfirmDiscard(false)}
              className="appearance-none border-none bg-transparent font-body text-[12px] text-neutral-500 cursor-pointer"
            >
              Keep editing
            </Button>
          </div>
        )}

        {library && (
          <div className="flex shrink-0 flex-col gap-2 border-b border-neutral-200 bg-off-white/60 px-4 py-3">
            <div className="flex flex-wrap items-start gap-3">
              <div className="flex min-w-[200px] flex-1 flex-col gap-1">
                <label className={metaLabelCls} htmlFor="pl-modal-name">
                  Name
                </label>
                <Input
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
                <Input
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
          <div
            className={`min-h-0 min-w-0 shrink-0 overflow-hidden transition-[width] duration-[var(--motion-base)] ease-standard motion-reduce:transition-none ${
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
    </Modal>
  );
}
