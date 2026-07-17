"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import type { FlowNodeDef } from "@/lib/flows";
import type { PromptLibraryListRowDto, PromptSourceRef, WorkflowParamValue } from "@shared/contracts";
import { driftFor, getPromptRef, makePromptRef } from "@/lib/prompt-library/provenance";
import { AVAILABLE_VARIABLES } from "@/lib/prompt-library/variables";
import { VariableChips } from "@/components/cockpit/prompt-library/variable-chips";
import { PromptPreview } from "@/components/cockpit/prompt-library/prompt-preview";
import { DiffView } from "@/components/cockpit/prompt-diff";
import { CkChip } from "@/components/ui";
import { ConfigField, monoTextareaCls, textareaCls } from "./config-fields";
import { PromptInsertPopup, type PromptInsertPayload } from "./prompt-insert-popup";
import { PromptSavePopover } from "./prompt-save-popover";
import { usePromptLibrary } from "./prompt-library-context";

export interface PromptFieldProps {
  label: string;
  paramKey: string;
  node: FlowNodeDef;
  disabled: boolean;
  mono?: boolean;
  placeholder?: string;
  helper?: React.ReactNode;
  builtInTemplate?: { name: string; body: string };
  onChange: (path: string, value: WorkflowParamValue | PromptSourceRef | undefined) => void;
}

const triggerBtn =
  "appearance-none cursor-pointer border-none bg-transparent rounded-xs px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.04em] text-mariner hover:bg-mariner-100";
const textBtn = "appearance-none border-none bg-transparent cursor-pointer p-0 font-body text-[11px]";
const confirmPrimary =
  "appearance-none cursor-pointer border border-mariner bg-mariner text-white py-1 px-2.5 rounded-[3px] font-mono text-[10px] tracking-[0.04em] uppercase";

export function PromptField({
  label,
  paramKey,
  node,
  disabled,
  mono,
  placeholder,
  helper,
  builtInTemplate,
  onChange,
}: PromptFieldProps) {
  const raw = node.params[paramKey];
  const value = typeof raw === "string" ? raw : "";
  const ref = getPromptRef(node, paramKey);
  const { status, rows } = usePromptLibrary();
  const drift = ref && status === "ready" ? driftFor(ref, value, rows) : null;

  const [insertOpen, setInsertOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveBody, setSaveBody] = useState("");
  const [templateOpen, setTemplateOpen] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);
  const [confirmUpdate, setConfirmUpdate] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Stable dismiss handlers: PromptInsertPopup's open-effect resets its state on
  // any onClose identity change (reviewer advisory), and PromptSavePopover reseeds
  // its fields on open, so an inline closure would clobber both.
  const closeInsert = useCallback(() => setInsertOpen(false), []);
  const closeSave = useCallback(() => setSaveOpen(false), []);
  const closeTemplate = useCallback(() => setTemplateOpen(false), []);

  // setRangeText mutates the DOM value; the dispatched input event lets React's
  // controlled-textarea tracker pick up the change and keep the caret. When the
  // caret sits right after a freshly typed "{{", replace it so braces don't double.
  const insertToken = useCallback((token: string) => {
    const el = textRef.current;
    if (!el) return;
    el.focus();
    const caret = el.selectionStart;
    const before = el.value.slice(Math.max(0, caret - 2), caret);
    if (before === "{{" && el.selectionStart === el.selectionEnd) {
      el.setRangeText(token, caret - 2, caret, "end");
    } else {
      el.setRangeText(token, el.selectionStart, el.selectionEnd, "end");
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    setAutoOpen(false);
  }, []);

  function handleTextChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    const v = el.value;
    onChange(`params.${paramKey}`, v);
    if (v.trim() === "") onChange(`promptRefs.${paramKey}`, undefined);
    const caret = el.selectionStart;
    setAutoOpen(v.slice(Math.max(0, caret - 2), caret) === "{{");
  }

  function onInsert(payload: PromptInsertPayload) {
    if (payload.mode === "replace") {
      onChange(`params.${paramKey}`, payload.text);
      onChange(`promptRefs.${paramKey}`, payload.ref ?? undefined);
    } else {
      onChange(`params.${paramKey}`, value ? `${value}\n\n${payload.text}` : payload.text);
    }
    setInsertOpen(false);
  }

  function openSave() {
    const el = textRef.current;
    const selected =
      el && el.selectionStart !== el.selectionEnd
        ? el.value.slice(el.selectionStart, el.selectionEnd)
        : value;
    setSaveBody(selected);
    setSaveOpen(true);
  }

  const detach = () => onChange(`promptRefs.${paramKey}`, undefined);
  function applyUpdate(row: PromptLibraryListRowDto) {
    onChange(`params.${paramKey}`, row.body);
    onChange(`promptRefs.${paramKey}`, makePromptRef(row.id, row.currentVersion, row.body));
    setConfirmUpdate(false);
  }

  const detachButton = !disabled ? (
    <button type="button" onClick={detach} className={`${textBtn} text-neutral-500 hover:text-coal`}>
      Detach
    </button>
  ) : null;

  let provenance: React.ReactNode = null;
  if (ref && status === "loading") {
    provenance = <CkChip tone="neutral">❡ v{ref.version}</CkChip>;
  } else if (ref && status === "error") {
    // Library failed to load: drift is unknown, so show a neutral version chip and
    // keep Detach reachable instead of hiding the provenance entirely.
    provenance = (
      <div className="flex items-center gap-2 flex-wrap">
        <span title="Library unavailable">
          <CkChip tone="neutral">❡ v{ref.version}</CkChip>
        </span>
        {detachButton}
      </div>
    );
  } else if (ref && drift) {
    if (drift.kind === "current") {
      provenance = (
        <div className="flex items-center gap-2 flex-wrap">
          <CkChip tone="neutral">
            ❡ {drift.row.name} · v{ref.version}
          </CkChip>
          {detachButton}
        </div>
      );
    } else if (drift.kind === "behind") {
      const latest = drift.latest;
      const row = drift.row;
      provenance = (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <CkChip tone="warn">
              ❡ {row.name} · v{ref.version} of v{latest}
            </CkChip>
            {!disabled && (
              <button type="button" onClick={() => setConfirmUpdate(true)} className={`${textBtn} text-mariner`}>
                Update to v{latest}
              </button>
            )}
            {detachButton}
          </div>
          {!disabled && confirmUpdate && (
            <div className="flex flex-col gap-2 border border-neutral-200 rounded-xs p-2">
              <div className="max-h-[240px] overflow-y-auto">
                <DiffView oldText={value} newText={row.body} />
              </div>
              <div className="flex items-center gap-3">
                <button type="button" onClick={() => applyUpdate(row)} className={confirmPrimary}>
                  Replace with v{latest}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmUpdate(false)}
                  className={`${textBtn} text-neutral-500 hover:text-coal`}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      );
    } else if (drift.kind === "edited") {
      provenance = (
        <div className="flex items-center gap-2 flex-wrap">
          <CkChip tone="neutral">
            ❡ {drift.row.name} · v{ref.version} · edited
          </CkChip>
          {detachButton}
        </div>
      );
    } else if (drift.kind === "archived") {
      provenance = (
        <div className="flex items-center gap-2 flex-wrap">
          <CkChip tone="neutral">
            ❡ {drift.row.name} · v{ref.version} · archived
          </CkChip>
          {detachButton}
        </div>
      );
    } else {
      provenance = (
        <div className="flex items-center gap-2 flex-wrap">
          <CkChip tone="neutral">Removed from library</CkChip>
          {detachButton}
        </div>
      );
    }
  }

  const chars = value.length;

  return (
    <ConfigField
      label={label}
      action={
        disabled ? undefined : (
          <>
            <button type="button" aria-haspopup="dialog" onClick={() => setInsertOpen(true)} className={triggerBtn}>
              ❡ Library
            </button>
            {value.trim().length > 0 && (
              <button type="button" aria-haspopup="dialog" onClick={openSave} className={triggerBtn}>
                Save to library
              </button>
            )}
          </>
        )
      }
    >
      <textarea
        ref={textRef}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        rows={4}
        onChange={handleTextChange}
        onKeyDown={(e) => {
          if (e.key === "Escape" && autoOpen) {
            e.preventDefault();
            setAutoOpen(false);
          }
        }}
        onBlur={() => setAutoOpen(false)}
        className={mono ? monoTextareaCls : textareaCls}
      />

      {autoOpen && !disabled && (
        <div className="flex flex-col border border-neutral-200 rounded-xs overflow-hidden">
          {AVAILABLE_VARIABLES.map((spec) => (
            <button
              key={spec.name}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertToken(`{{${spec.name}}}`)}
              className="block w-full appearance-none cursor-pointer text-left px-2 py-1.5 border-b border-neutral-200 last:border-b-0 bg-panel hover:bg-[#FAFBFC]"
            >
              <div className="font-mono text-[11px] text-neutral-900">{spec.name}</div>
              <div className="text-[10px] text-neutral-500">{spec.description}</div>
            </button>
          ))}
        </div>
      )}

      <VariableChips body={value} onInsertToken={disabled ? undefined : insertToken} disabled={disabled} />

      {chars > 0 && (
        <div className="font-mono text-[9px] text-neutral-500">
          {chars} chars · ~{Math.ceil(chars / 4)} tokens
        </div>
      )}

      {(helper || builtInTemplate) && (
        <div className="flex flex-col gap-1">
          {helper && <div className="font-body text-[11px] leading-[1.4] text-neutral-600">{helper}</div>}
          {builtInTemplate && (
            <button
              type="button"
              onClick={() => setTemplateOpen(true)}
              className="self-start appearance-none border-none bg-transparent cursor-pointer p-0 font-body text-[11px] text-mariner underline"
            >
              View built-in template
            </button>
          )}
        </div>
      )}

      {provenance}

      <PromptInsertPopup
        open={insertOpen}
        onClose={closeInsert}
        fieldLabel={label}
        blockName={node.name || node.type}
        targetHasContent={value.trim().length > 0}
        onInsert={onInsert}
      />
      <PromptSavePopover open={saveOpen} onClose={closeSave} initialBody={saveBody} onSaved={closeSave} />
      {builtInTemplate && (
        <TemplateModal
          open={templateOpen}
          onClose={closeTemplate}
          name={builtInTemplate.name}
          body={builtInTemplate.body}
        />
      )}
    </ConfigField>
  );
}

/** Read-only preview of a block's built-in prompt template. */
function TemplateModal({
  open,
  onClose,
  name,
  body,
}: {
  open: boolean;
  onClose: () => void;
  name: string;
  body: string;
}) {
  const [mounted, setMounted] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  useEffect(() => setMounted(true), []);
  // On open: capture the previously focused element, lock body scroll, move focus
  // to the Close button so aria-modal has a focus target, and dismiss on Escape
  // (capture + stopImmediatePropagation so the editor's own window Escape handlers
  // stay quiet, matching the insert popup). Restore focus to the opener on close.
  useEffect(() => {
    if (!open) return;
    restoreFocus.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const raf = requestAnimationFrame(() => closeRef.current?.focus());
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onEsc, { capture: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onEsc, { capture: true });
      document.body.style.overflow = prevOverflow;
      restoreFocus.current?.focus?.();
    };
  }, [open, onClose]);

  if (!mounted || !open) return null;

  return createPortal(
    <div
      role="presentation"
      onMouseDown={onClose}
      className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[12vh] bg-coal/50 backdrop-blur-[2px]"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Built-in template: ${name}`}
        onMouseDown={(e) => e.stopPropagation()}
        className="flex w-full max-w-[640px] flex-col overflow-hidden rounded-md bg-panel shadow-[0_24px_64px_-16px_rgba(24,27,32,0.45)] animate-ck-pop motion-reduce:animate-none"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-neutral-200 shrink-0">
          <h3 className="m-0 font-display text-[15px] font-semibold text-neutral-900">{name}</h3>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="ml-auto appearance-none cursor-pointer border border-neutral-200 bg-panel text-coal py-1 px-2.5 rounded-[3px] font-mono text-[11px] tracking-[0.04em] uppercase hover:bg-app-bg"
          >
            Close
          </button>
        </div>
        <div className="px-4 py-3">
          <PromptPreview body={body} maxHeightClass="max-h-[60vh]" />
        </div>
      </div>
    </div>,
    document.body,
  );
}
