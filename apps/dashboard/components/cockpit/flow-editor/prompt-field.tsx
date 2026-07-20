"use client";

import { useCallback, useMemo, useState } from "react";
import type { FlowNodeDef } from "@/lib/flows";
import type { PromptLibraryListRowDto, PromptSourceRef, WorkflowParamValue } from "@shared/contracts";
import { driftFor, getPromptRef, makePromptRef } from "@/lib/prompt-library/provenance";
import { DiffView } from "@/components/cockpit/prompt-diff";
import { CkChip } from "@/components/ui";
import { ConfigField } from "./config-fields";
import type { PromptInsertPayload } from "./prompt-insert-popup";
import { PromptEditorModal } from "./prompt-editor-modal";
import { PromptInspectorCard } from "./prompt-inspector-card";
import { PromptReferenceChips } from "@/components/cockpit/prompt-editor/prompt-reference-chips";
import { usePromptLibrary } from "./prompt-library-context";
import { effectiveDefaultPromptValue } from "@/lib/prompt-library/effective-default";
import { promptInspectorSummary } from "@/lib/prompt-library/prompt-inspector-summary";

export interface PromptFieldProps {
  label: string;
  paramKey: string;
  node: FlowNodeDef;
  disabled: boolean;
  mono?: boolean;
  placeholder?: string;
  defaultPromptName?: string;
  onChange: (path: string, value: WorkflowParamValue | PromptSourceRef | undefined) => void;
}

const textBtn = "appearance-none border-none bg-transparent cursor-pointer p-0 font-body text-[11px]";
const confirmPrimary =
  "appearance-none cursor-pointer border border-mariner bg-mariner text-white py-1 px-2.5 rounded-[3px] font-mono text-[10px] tracking-[0.04em] uppercase";

export function PromptField({
  label,
  paramKey,
  node,
  disabled,
  defaultPromptName,
  onChange,
}: PromptFieldProps) {
  const raw = node.params[paramKey];
  const value = typeof raw === "string" ? raw : "";
  const ref = getPromptRef(node, paramKey);
  const { status, rows } = usePromptLibrary();
  const effective = useMemo(
    () => effectiveDefaultPromptValue(value, defaultPromptName, rows),
    [defaultPromptName, rows, value],
  );
  const effectiveValue = effective.value;
  const summary = useMemo(
    () => promptInspectorSummary(value, effectiveValue, defaultPromptName, rows),
    [defaultPromptName, effectiveValue, rows, value],
  );
  // driftFor hashes the full field value (up to ~50k chars); memoize so an
  // unrelated re-render (popover toggles, autoOpen, etc.) does not re-hash. The
  // result is identical, only recomputed when an input actually changes.
  const drift = useMemo(
    () => (ref && status === "ready" ? driftFor(ref, value, rows) : null),
    [ref, status, value, rows],
  );

  const [confirmUpdate, setConfirmUpdate] = useState(false);
  const [expandOpen, setExpandOpen] = useState(false);

  const closeExpandedEditor = useCallback(() => setExpandOpen(false), []);

  function setBodyValue(v: string) {
    onChange(`params.${paramKey}`, v);
    if (v.trim() === "") onChange(`promptRefs.${paramKey}`, undefined);
  }

  function applyInsertPayload(payload: PromptInsertPayload, baseValue = value) {
    if (payload.mode === "replace") {
      onChange(`params.${paramKey}`, payload.text);
      onChange(`promptRefs.${paramKey}`, payload.ref ?? undefined);
    } else {
      onChange(`params.${paramKey}`, baseValue ? `${baseValue}\n\n${payload.text}` : payload.text);
    }
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

  return (
    <ConfigField label={label}>
      <PromptInspectorCard
        label={label}
        disabled={disabled}
        summary={summary}
        onOpen={() => setExpandOpen(true)}
      />
      {effectiveValue ? (
        <PromptReferenceChips value={effectiveValue} onChange={setBodyValue} disabled={disabled} />
      ) : effective.implicit ? (
        <CkChip tone="neutral">❡ {defaultPromptName ?? "Default prompt"} · Latest</CkChip>
      ) : null}

      {provenance}
      <PromptEditorModal
        open={expandOpen}
        disabled={disabled}
        onClose={closeExpandedEditor}
        value={effectiveValue}
        onChange={setBodyValue}
        onInsert={(payload) => applyInsertPayload(payload, effectiveValue)}
        blockName={node.name || node.type}
        fieldLabel={label}
      />
    </ConfigField>
  );
}
