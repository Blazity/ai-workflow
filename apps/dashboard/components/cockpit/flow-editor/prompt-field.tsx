"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FlowNodeDef } from "@/lib/flows";
import {
  parsePromptReferenceTokens,
  promptReferenceMatchesRow,
  type PromptLibraryVersion,
  type PromptLibraryVersionResponse,
  type PromptLibraryListRowDto,
  type PromptSourceRef,
  type JsonValue,
  type WorkflowParamValue,
} from "@shared/contracts";
import { driftFor, getPromptRef, makePromptRef } from "@/lib/prompt-library/provenance";
import { DiffView } from "@/components/cockpit/prompt-diff";
import { CkChip } from "@/components/ui";
import { ConfigField } from "./config-fields";
import type { PromptInsertPayload } from "./prompt-insert-popup";
import { PromptEditorModal } from "./prompt-editor-modal";
import { PromptInspectorCard } from "./prompt-inspector-card";
import { usePromptLibrary } from "./prompt-library-context";
import { effectiveDefaultPromptValue } from "@/lib/prompt-library/effective-default";
import { promptInspectorSummary } from "@/lib/prompt-library/prompt-inspector-summary";
import {
  includePendingPromptSlotBindings,
  promptVersionLoadRequests,
  resolvePromptSlotsFromLibrary,
} from "@/lib/prompt-library/slots";
import {
  PromptSlotBindingsEditor,
  promptSlotBindingsFromConfiguration,
} from "@/components/cockpit/prompt-editor/prompt-slot-fields";
import { usePromptAuthoringContext } from "./prompt-authoring-context";
import { EffectivePromptPreview } from "./effective-prompt-preview";

export interface PromptFieldProps {
  label: string;
  paramKey: string;
  node: FlowNodeDef;
  disabled: boolean;
  mono?: boolean;
  placeholder?: string;
  defaultPromptName?: string;
  /** Only harness-backed agent blocks compile slots and an effective prompt. */
  agentPromptAuthoring?: boolean;
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
  agentPromptAuthoring = true,
  onChange,
}: PromptFieldProps) {
  const raw = node.params[paramKey];
  const value = typeof raw === "string" ? raw : "";
  const ref = getPromptRef(node, paramKey);
  const { status, rows } = usePromptLibrary();
  const promptAuthoring = usePromptAuthoringContext();
  const v2 = node.v2 !== undefined;
  const effective = useMemo(
    () =>
      v2
        ? { value, implicit: false }
        : effectiveDefaultPromptValue(value, defaultPromptName, rows),
    [defaultPromptName, rows, v2, value],
  );
  const effectiveValue = effective.value;
  const summary = useMemo(
    () =>
      promptInspectorSummary(
        value,
        effectiveValue,
        v2 ? undefined : defaultPromptName,
        rows,
      ),
    [defaultPromptName, effectiveValue, rows, v2, value],
  );
  const supportsSlots = v2 && agentPromptAuthoring;
  const [versionSnapshots, setVersionSnapshots] = useState<
    Record<string, PromptLibraryVersion>
  >({});
  const [failedVersionKeys, setFailedVersionKeys] = useState<Set<string>>(
    () => new Set(),
  );
  useEffect(() => {
    setFailedVersionKeys(new Set());
  }, [rows]);
  const slotResolution = useMemo(
    () =>
      supportsSlots
        ? resolvePromptSlotsFromLibrary(
            effectiveValue,
            rows,
            versionSnapshots,
          )
        : {
            definitions: [],
            conflicts: [],
            unresolvedReferences: [],
          },
    [effectiveValue, rows, supportsSlots, versionSnapshots],
  );
  const slotBindings = useMemo(
    () =>
      node.v2
        ? promptSlotBindingsFromConfiguration(node.v2.configuration)
        : {},
    [node.v2],
  );
  const versionLoadRequests = useMemo(
    () =>
      promptVersionLoadRequests(
        slotResolution.unresolvedReferences,
        rows,
        versionSnapshots,
        failedVersionKeys,
      ),
    [
      failedVersionKeys,
      rows,
      slotResolution.unresolvedReferences,
      versionSnapshots,
    ],
  );
  const versionLoadKey = versionLoadRequests
    .map((request) => request.key)
    .sort()
    .join(",");
  useEffect(() => {
    if (!supportsSlots || versionLoadRequests.length === 0) return;
    const controller = new AbortController();
    for (const request of versionLoadRequests) {
      void fetch(
        `/api/prompt-library/${request.promptId}/versions/${request.version}`,
        { cache: "no-store", signal: controller.signal },
      )
        .then(async (response) => {
          if (!response.ok) throw new Error(String(response.status));
          const payload = (await response.json()) as PromptLibraryVersionResponse;
          if (
            payload.version.promptId !== request.promptId ||
            payload.version.version !== request.version
          ) {
            throw new Error("Prompt version response did not match its request");
          }
          setVersionSnapshots((current) =>
            current[request.key]
              ? current
              : { ...current, [request.key]: payload.version },
          );
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setFailedVersionKeys((current) => {
            if (current.has(request.key)) return current;
            const next = new Set(current);
            next.add(request.key);
            return next;
          });
        });
    }
    return () => controller.abort();
    // The key deliberately represents the request set. Depending on the array
    // identity would abort and restart the same immutable-version fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supportsSlots, versionLoadKey]);
  const visibleSlotDefinitions = useMemo(
    () =>
      includePendingPromptSlotBindings(
        slotResolution.definitions,
        slotBindings,
        slotResolution.unresolvedReferences.length > 0,
      ),
    [
      slotBindings,
      slotResolution.definitions,
      slotResolution.unresolvedReferences.length,
    ],
  );
  const initialPreviewTarget = useMemo(() => {
    const references = parsePromptReferenceTokens(effectiveValue);
    const reference = references.length === 1 && effectiveValue.trim() === references[0]?.raw
      ? references[0]
      : null;
    if (!reference) return null;
    const row = rows.find((candidate) => promptReferenceMatchesRow(reference, candidate));
    return row ? { promptId: row.id, version: reference.version } : null;
  }, [effectiveValue, rows]);
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

  function updateSlotBindings(
    bindings: ReturnType<typeof promptSlotBindingsFromConfiguration>,
  ) {
    if (!node.v2 || !promptAuthoring) return;
    const configuration = { ...node.v2.configuration };
    if (Object.keys(bindings).length === 0) {
      delete configuration.promptSlotBindings;
    } else {
      configuration.promptSlotBindings =
        bindings as unknown as JsonValue;
    }
    promptAuthoring.onV2ConfigurationChange(configuration);
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
      {provenance}
      {supportsSlots && slotResolution.conflicts.length > 0 && (
        <div className="rounded-xs border border-red-200 bg-red-50 px-2 py-1.5 font-body text-[10px] text-red-800">
          Conflicting declarations for{" "}
          {slotResolution.conflicts.join(", ")}. Update the referenced prompts
          before deployment.
        </div>
      )}
      {supportsSlots && slotResolution.unresolvedReferences.length > 0 && (
        <div className="rounded-xs border border-neutral-200 bg-off-white px-2 py-1.5 font-body text-[10px] text-neutral-600">
          {versionLoadRequests.length > 0
            ? "Loading slot details from pinned prompt versions…"
            : "Some pinned prompt slot details are unavailable. Workflow validation will check them before deployment."}
        </div>
      )}
      {supportsSlots && (
        <PromptSlotBindingsEditor
          definitions={visibleSlotDefinitions}
          bindings={slotBindings}
          availableValues={promptAuthoring?.availableValues ?? []}
          disabled={disabled || !promptAuthoring}
          onChange={updateSlotBindings}
        />
      )}
      {supportsSlots && promptAuthoring?.previewCandidate && (
        <EffectivePromptPreview {...promptAuthoring.previewCandidate} />
      )}
      <PromptEditorModal
        open={expandOpen}
        disabled={disabled}
        onClose={closeExpandedEditor}
        value={effectiveValue}
        onChange={setBodyValue}
        onInsert={(payload) => applyInsertPayload(payload, effectiveValue)}
        blockName={node.name || node.type}
        fieldLabel={label}
        initialPreviewTarget={initialPreviewTarget}
        authoringMode={v2 ? "v2" : "v1"}
        availableValues={promptAuthoring?.availableValues ?? []}
        slots={supportsSlots ? visibleSlotDefinitions : []}
      />
    </ConfigField>
  );
}
