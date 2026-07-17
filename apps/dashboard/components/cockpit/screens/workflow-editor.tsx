"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  isTriggerBlockType,
  type RunBlockStatusesResponse,
  type WorkflowDefinition,
  type WorkflowDefinitionDeployment,
  type WorkflowDefinitionDeploymentResponse,
  type WorkflowDefinitionDetailResponse,
  type WorkflowDefinitionLayoutResponse,
  type WorkflowDefinitionMeta,
  type WorkflowDefinitionNode,
  type WorkflowDefinitionSaveResponse,
  type WorkflowDefinitionValidationResponse,
  type WorkflowDefinitionVersion,
  type WorkflowExecutionBudgets,
  type WorkflowEditorOptions,
} from "@shared/contracts";
import { FlowEditor } from "@/components/cockpit/flow-editor/flow-editor";
import { Listbox } from "@/components/cockpit/listbox";
import type { FlowEdgeDef, FlowNodeDef } from "@/lib/flows";
import { readErrorMessage } from "@/lib/api/error-message";
import {
  serializeSemanticWorkflowDefinition,
  serializeWorkflowDefinition,
  serializeWorkflowLayout,
} from "@/lib/workflow-editor/serialize";
import { deriveRunStatuses } from "@/lib/workflow-editor/run-statuses";
import {
  reduceDefinitionSwitch,
  type DefinitionSwitchState,
} from "@/lib/workflow-editor/definition-switch";
import {
  afterPendingLayoutSave,
  createPendingLayoutSave,
  type PendingLayoutSave,
} from "@/lib/workflow-editor/layout-save";
import {
  createWorkflowValidationController,
  type WorkflowValidationController,
  type WorkflowValidationState,
} from "@/lib/workflow-editor/validation-controller";
import { workflowEditorActions } from "@/lib/workflow-editor/editor-actions";
import { executionLimitsFromDefinition } from "@/lib/workflow-editor/execution-limits";
import { validatedBindingInputNames } from "@/lib/workflow-editor/binding-options";

interface ValidationRequest {
  definitionId: number;
  definition: WorkflowDefinition;
}

function toViewNodes(nodes: WorkflowDefinitionNode[]): FlowNodeDef[] {
  return structuredClone(nodes).map((node) => ({
    ...node,
    locked: node.type === "trigger_ticket_ai",
  }));
}

function nodesValid(nodes: FlowNodeDef[]): boolean {
  if (!nodes.some((n) => isTriggerBlockType(n.type))) return false;
  for (const node of nodes) {
    if (node.type === "update_ticket_status" && typeof node.params.target !== "string") return false;
    if (node.type === "run_pre_pr_checks") {
      const cycles = node.params.maxFixCycles;
      if (cycles !== undefined && (typeof cycles !== "number" || cycles < 0 || cycles > 5)) return false;
    }
  }
  return true;
}

const headerButtonClass =
  "appearance-none cursor-pointer border border-neutral-200 bg-panel text-coal py-1.5 px-3 rounded-[3px] font-mono text-[11px] tracking-[0.04em] uppercase hover:bg-app-bg";

export function WorkflowEditorScreen({
  definitions,
  initialDetail,
  defaultDefinition,
  options,
  liveBlocks,
  canEdit,
}: {
  definitions: WorkflowDefinitionMeta[];
  initialDetail: WorkflowDefinitionDetailResponse;
  defaultDefinition: WorkflowDefinition;
  options: WorkflowEditorOptions;
  liveBlocks: RunBlockStatusesResponse;
  canEdit: boolean;
}) {
  const seed = initialDetail.draft ?? initialDetail.deployed?.definition ?? defaultDefinition;
  const [metas, setMetas] = useState<WorkflowDefinitionMeta[]>(definitions);
  const [selectedId, setSelectedId] = useState(initialDetail.meta.id);
  const [versions, setVersions] = useState<WorkflowDefinitionVersion[]>(initialDetail.versions);
  const [deployments, setDeployments] = useState<WorkflowDefinitionDeployment[]>(initialDetail.deployments);
  const [deployed, setDeployed] = useState<WorkflowDefinitionVersion | null>(initialDetail.deployed);
  const [baselineDraft, setBaselineDraft] = useState<WorkflowDefinition | null>(initialDetail.draft);
  const [budgets, setBudgets] = useState<WorkflowExecutionBudgets>(() =>
    executionLimitsFromDefinition(seed),
  );
  const [layoutBaseline, setLayoutBaseline] = useState(() => JSON.stringify(initialDetail.layout));
  const [nodes, setNodes] = useState<FlowNodeDef[]>(() => toViewNodes(seed.nodes));
  const [edges, setEdges] = useState<FlowEdgeDef[]>(() => structuredClone(seed.edges));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [fitSignal, setFitSignal] = useState(0);
  const [switchState, setSwitchState] = useState<DefinitionSwitchState>({ kind: "idle" });
  const [defsOpen, setDefsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [rowError, setRowError] = useState<{ id: number; message: string } | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newSource, setNewSource] = useState("default");
  const [validation, setValidation] = useState<{
    key: string | null;
    state: WorkflowValidationState;
  }>({
    key: null,
    state: { status: "checking", issues: [], nodeContracts: {} },
  });
  const pendingLayoutSaveRef = useRef<PendingLayoutSave | null>(null);
  if (pendingLayoutSaveRef.current === null) {
    pendingLayoutSaveRef.current = createPendingLayoutSave();
  }
  const pendingLayoutSave = pendingLayoutSaveRef.current;
  const validationKeyRef = useRef<string | null>(null);
  const validationControllerRef = useRef<WorkflowValidationController<ValidationRequest> | null>(
    null,
  );
  if (validationControllerRef.current === null) {
    validationControllerRef.current = createWorkflowValidationController<ValidationRequest>({
      validate: async ({ definitionId, definition }, signal) => {
        const res = await fetch(`/api/workflow-definitions/${definitionId}/validate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ definition }),
          signal,
        });
        if (!res.ok) throw new Error(await readErrorMessage(res));
        return (await res.json()) as WorkflowDefinitionValidationResponse;
      },
      onState: (state) => setValidation({ key: validationKeyRef.current, state }),
    });
  }
  const validationController = validationControllerRef.current;

  const selectedMeta = metas.find((m) => m.id === selectedId);
  const semanticDefinition = useMemo(
    () => serializeSemanticWorkflowDefinition(nodes, edges, budgets),
    [budgets, edges, nodes],
  );
  const semanticDefinitionRef = useRef(semanticDefinition);
  semanticDefinitionRef.current = semanticDefinition;
  const semanticKey = JSON.stringify(semanticDefinition);
  const baselineSemanticKey =
    baselineDraft === null
      ? null
      : JSON.stringify(
          serializeSemanticWorkflowDefinition(
            toViewNodes(baselineDraft.nodes),
            structuredClone(baselineDraft.edges),
            executionLimitsFromDefinition(baselineDraft),
          ),
        );
  const validationTargetKey = `${selectedId}:${semanticKey}`;
  const validationIsCurrent = validation.key === validationTargetKey;
  const repairedInputsByNode = validationIsCurrent
    ? Object.fromEntries(
        semanticDefinition.nodes.map((node) => [
          node.id,
          validatedBindingInputNames({
            definition: semanticDefinition,
            consumerId: node.id,
            options,
            nodeContracts: validation.state.nodeContracts,
          }),
        ]),
      )
    : {};
  const compatibilityRepairPending =
    validationIsCurrent &&
    JSON.stringify(
      serializeSemanticWorkflowDefinition(nodes, edges, budgets, {
        repairedInputsByNode,
      }),
    ) !== semanticKey;
  const dirty =
    baselineSemanticKey === null ||
    semanticKey !== baselineSemanticKey ||
    compatibilityRepairPending;
  const { canSave, canDeploy } = workflowEditorActions({
    dirty,
    structurallyValid: nodesValid(nodes),
    hasDraft: baselineDraft !== null,
    validationStatus: validation.state.status,
    validationIsCurrent,
  });

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy prompt trigger, still required by Chrome/Edge before 119. An empty string
      // does not count as set, so this has to be truthy.
      e.returnValue = true;
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    validationKeyRef.current = validationTargetKey;
    validationController.schedule({
      definitionId: selectedId,
      definition: semanticDefinitionRef.current,
    });
  }, [selectedId, validationController, validationTargetKey]);

  useEffect(() => () => validationController.dispose(), [validationController]);

  useEffect(() => {
    if (!canEdit || !selectedMeta) {
      pendingLayoutSave.discard();
      return;
    }
    const layout = serializeWorkflowLayout(nodes);
    const serialized = JSON.stringify(layout);
    if (serialized === layoutBaseline) {
      pendingLayoutSave.discard();
      return;
    }
    const definitionId = selectedId;
    const expectedLayoutRevision = selectedMeta.layoutRevision;
    pendingLayoutSave.schedule(async () => {
      try {
        const res = await fetch(`/api/workflow-definitions/${definitionId}/layout`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ layout, expectedLayoutRevision }),
        });
        if (!res.ok) {
          setError(await readErrorMessage(res));
          return false;
        }
        const body = (await res.json()) as WorkflowDefinitionLayoutResponse;
        setMetas((prev) => prev.map((meta) => (meta.id === body.meta.id ? body.meta : meta)));
        setLayoutBaseline(JSON.stringify(body.layout));
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to save layout");
        return false;
      }
    });
  }, [canEdit, layoutBaseline, nodes, pendingLayoutSave, selectedId, selectedMeta]);

  useEffect(() => () => pendingLayoutSave.discard(), [pendingLayoutSave]);

  const run = liveBlocks.run;
  const derived = deriveRunStatuses(run, {
    definitionId: selectedId,
    version: deployed?.version ?? null,
  });

  let statusBar: React.ReactNode = null;
  if (derived && run) {
    const nodeName = (id: string) => nodes.find((n) => n.id === id)?.name || id;
    const truncate = (s: string) => (s.length > 120 ? s.slice(0, 120) + "…" : s);
    const ids = Object.keys(derived.statuses);
    const runningId = ids.find((id) => derived.statuses[id] === "running");
    const failId = ids.find((id) => derived.statuses[id] === "fail");
    const warnId = ids.find((id) => derived.statuses[id] === "warn");

    let statusText: string;
    if (runningId) {
      statusText = `Running: ${nodeName(runningId)}`;
    } else if (run.status === "failed" || failId) {
      const where = failId ? nodeName(failId) : "run";
      const err = failId ? derived.errors[failId] : undefined;
      statusText = err ? `Failed at ${where}: ${truncate(err)}` : `Failed at ${where}`;
    } else if (warnId) {
      const err = derived.errors[warnId];
      statusText = err
        ? `Awaiting: questions on the ticket: ${truncate(err)}`
        : "Awaiting: questions on the ticket";
    } else {
      statusText = "Completed";
    }

    const ticketLabel = run.ticketKey ?? run.runId.slice(0, 8);
    statusBar = (
      <div className="flex items-center gap-2 px-6 py-2 border-b border-neutral-200 bg-app-bg font-body text-[12px] text-neutral-700">
        <span className="font-mono text-[11px] font-semibold text-coal">{ticketLabel}</span>
        <span className="rounded-full border border-neutral-200 bg-panel px-2 py-0.5 font-mono text-[10px] font-semibold tracking-[0.04em] uppercase text-neutral-600">
          {run.source === "live" ? "Live" : "Last run"}
        </span>
        <span className="truncate">{statusText}</span>
      </div>
    );
  }

  function applySave(res: WorkflowDefinitionSaveResponse, refit: boolean) {
    setBaselineDraft(res.draft);
    setBudgets(executionLimitsFromDefinition(res.draft));
    setNodes(toViewNodes(res.draft.nodes));
    setEdges(structuredClone(res.draft.edges));
    setMetas((prev) => prev.map((m) => (m.id === res.meta.id ? res.meta : m)));
    if (refit) setFitSignal((s) => s + 1);
  }

  async function save() {
    setBusy("save");
    setError(null);
    try {
      await afterPendingLayoutSave(pendingLayoutSave, async () => {
        const res = await fetch(`/api/workflow-definitions/${selectedId}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            definition: serializeWorkflowDefinition(nodes, edges, budgets, {
              repairedInputsByNode,
            }),
            expectedDraftRevision: selectedMeta?.draftRevision ?? 0,
          }),
        });
        if (!res.ok) {
          setError(await readErrorMessage(res));
          return;
        }
        applySave((await res.json()) as WorkflowDefinitionSaveResponse, false);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save changes");
    } finally {
      setBusy(null);
    }
  }

  async function deploy() {
    if (!selectedMeta) return;
    setBusy("deploy");
    setError(null);
    try {
      const res = await fetch(`/api/workflow-definitions/${selectedId}/deploy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedDraftRevision: selectedMeta.draftRevision,
          expectedDeployedVersion: selectedMeta.deployedVersion,
        }),
      });
      if (!res.ok) {
        setError(await readErrorMessage(res));
        return;
      }
      const body = (await res.json()) as WorkflowDefinitionDeploymentResponse;
      setDeployed(body.deployed);
      setVersions((prev) => [body.deployed, ...prev.filter((item) => item.version !== body.deployed.version)]);
      setDeployments((prev) => [body.deployment, ...prev]);
      setMetas((prev) => prev.map((meta) => (meta.id === body.meta.id ? body.meta : meta)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to deploy draft");
    } finally {
      setBusy(null);
    }
  }

  async function rollback(version: number) {
    setBusy(`rollback-${version}`);
    setError(null);
    try {
      const res = await fetch(`/api/workflow-definitions/${selectedId}/rollback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version, expectedDeployedVersion: selectedMeta?.deployedVersion ?? null }),
      });
      if (!res.ok) {
        setError(await readErrorMessage(res));
        return;
      }
      const body = (await res.json()) as WorkflowDefinitionDeploymentResponse;
      setDeployed(body.deployed);
      setDeployments((prev) => [body.deployment, ...prev]);
      setMetas((prev) => prev.map((meta) => (meta.id === body.meta.id ? body.meta : meta)));
      setConfirmRestore(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to roll back version");
    } finally {
      setBusy(null);
    }
  }

  async function applySwitch(targetId: number) {
    setBusy("switch");
    setError(null);
    try {
      const res = await fetch(`/api/workflow-definitions/${targetId}`);
      if (!res.ok) {
        setError(await readErrorMessage(res));
        return;
      }
      const detail = (await res.json()) as WorkflowDefinitionDetailResponse;
      setSelectedId(detail.meta.id);
      setMetas((prev) => prev.map((m) => (m.id === detail.meta.id ? detail.meta : m)));
      setVersions(detail.versions);
      setDeployments(detail.deployments);
      setDeployed(detail.deployed);
      setBaselineDraft(detail.draft);
      setLayoutBaseline(JSON.stringify(detail.layout));
      const def = detail.draft ?? detail.deployed?.definition ?? defaultDefinition;
      setBudgets(executionLimitsFromDefinition(def));
      setNodes(toViewNodes(def.nodes));
      setEdges(structuredClone(def.edges));
      setConfirmRestore(null);
      setFitSignal((s) => s + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load definition");
    } finally {
      setBusy(null);
    }
  }

  async function requestSwitch(targetId: number) {
    if (targetId === selectedId) return;
    const t = reduceDefinitionSwitch(switchState, { type: "request", targetId, dirty });
    setSwitchState(t.state);
    if (t.switchTo !== null) {
      await afterPendingLayoutSave(pendingLayoutSave, () => applySwitch(t.switchTo!));
    }
  }

  async function confirmSwitch() {
    const t = reduceDefinitionSwitch(switchState, { type: "confirm" });
    setSwitchState(t.state);
    if (t.switchTo !== null) {
      await afterPendingLayoutSave(pendingLayoutSave, () => applySwitch(t.switchTo!));
    }
  }

  function cancelSwitch() {
    setSwitchState(reduceDefinitionSwitch(switchState, { type: "cancel" }).state);
  }

  async function patchDefinition(id: number, body: { name?: string; enabled?: boolean }) {
    setBusy(`patch-${id}`);
    setRowError(null);
    try {
      const res = await fetch(`/api/workflow-definitions/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setRowError({ id, message: await readErrorMessage(res) });
        return;
      }
      const meta = (await res.json()) as WorkflowDefinitionMeta;
      setMetas((prev) => prev.map((m) => (m.id === meta.id ? meta : m)));
    } catch (err) {
      setRowError({ id, message: err instanceof Error ? err.message : "Unable to update definition" });
    } finally {
      setBusy(null);
    }
  }

  async function deleteDefinition(id: number) {
    setBusy(`delete-${id}`);
    setRowError(null);
    try {
      const res = await fetch(`/api/workflow-definitions/${id}`, { method: "DELETE" });
      if (!res.ok) {
        setRowError({ id, message: await readErrorMessage(res) });
        return;
      }
      const remaining = metas.filter((m) => m.id !== id);
      setMetas(remaining);
      setConfirmDelete(null);
      if (id === selectedId && remaining[0]) await applySwitch(remaining[0].id);
    } catch (err) {
      setRowError({ id, message: err instanceof Error ? err.message : "Unable to delete definition" });
    } finally {
      setBusy(null);
    }
  }

  async function createDefinition() {
    const name = newName.trim();
    if (!name) return;
    setBusy("create");
    setCreateError(null);
    try {
      const source =
        newSource === "default"
          ? { kind: "default" as const }
          : { kind: "duplicate" as const, definitionId: Number(newSource) };
      const res = await fetch("/api/workflow-definitions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, source }),
      });
      if (!res.ok) {
        setCreateError(await readErrorMessage(res));
        return;
      }
      const detail = (await res.json()) as WorkflowDefinitionDetailResponse;
      setMetas((prev) => [...prev, detail.meta]);
      setNewName("");
      setNewSource("default");
      await requestSwitch(detail.meta.id);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Unable to create definition");
    } finally {
      setBusy(null);
    }
  }

  const enabledPillClass = (enabled: boolean) =>
    `rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold tracking-[0.04em] uppercase ${
      enabled ? "border-mariner text-mariner" : "border-neutral-200 text-neutral-600"
    }`;

  return (
    <div className="flex flex-col h-full min-h-0">
      {deployed === null && (
        <div className="px-6 py-2 border-b border-neutral-200 bg-app-bg font-body text-[12px] text-neutral-600">
          No deployed version selected. Save a draft, then deploy it when it is ready.
        </div>
      )}
      {switchState.kind === "confirming" && (
        <div className="flex items-center gap-3 px-6 py-2 border-b border-neutral-200 bg-app-bg font-body text-[12px] text-neutral-700">
          <span>Discard unsaved changes and switch?</span>
          <button
            onClick={() => void confirmSwitch()}
            disabled={busy !== null}
            className="appearance-none border-none bg-transparent font-body text-[12px] font-semibold text-red-600 cursor-pointer disabled:opacity-40"
          >
            Discard and switch
          </button>
          <button
            onClick={cancelSwitch}
            className="appearance-none border-none bg-transparent font-body text-[12px] text-neutral-500 cursor-pointer"
          >
            Cancel
          </button>
        </div>
      )}
      {statusBar}
      <div className="relative flex-1 min-h-0">
        <FlowEditor
          key={selectedId}
          nodes={nodes}
          edges={edges}
          limits={budgets}
          onLimitsChange={setBudgets}
          onNodesChange={setNodes}
          onEdgesChange={setEdges}
          canEdit={canEdit}
          dirty={dirty}
          saveEnabled={canSave}
          saving={busy === "save"}
          error={error}
          validation={
            validationIsCurrent
              ? validation.state
              : { status: "checking", issues: [], nodeContracts: {} }
          }
          onSave={save}
          saveLabel="Save draft"
          headerTitle={selectedMeta?.name ?? "Workflow"}
          headerVersionBadge={deployed ? `deployed v${deployed.version}` : "not deployed"}
          headerExtra={
            <>
              {canEdit && (
                <button
                  onClick={() => void deploy()}
                  disabled={!canDeploy || busy !== null}
                  className="appearance-none cursor-pointer border border-emerald-600 bg-emerald-600 text-white py-1.5 px-3 rounded-[3px] font-mono text-[11px] tracking-[0.04em] uppercase disabled:opacity-40 disabled:cursor-default"
                >
                  {busy === "deploy" ? "Deploying…" : "Deploy"}
                </button>
              )}
              <div className="w-[190px]">
                <Listbox
                  options={metas.map((m) => ({
                    value: String(m.id),
                    label: m.name,
                    hint: m.enabled ? "enabled" : "disabled",
                  }))}
                  value={String(selectedId)}
                  onChange={(v) => void requestSwitch(Number(v))}
                  disabled={busy !== null}
                  ariaLabel="Workflow definition"
                />
              </div>
              <button
                onClick={() => {
                  setDefsOpen((o) => !o);
                  setHistoryOpen(false);
                }}
                className={headerButtonClass}
              >
                Definitions ({metas.length})
              </button>
              <button
                onClick={() => {
                  setHistoryOpen((o) => !o);
                  setDefsOpen(false);
                }}
                className={headerButtonClass}
              >
                History ({deployments.length})
              </button>
            </>
          }
          options={options}
          runStatuses={derived?.statuses}
          runErrors={derived?.errors}
          fitSignal={fitSignal}
        />
        {defsOpen && (
          <div className="absolute right-4 top-[56px] z-[60] w-[420px] max-h-[60vh] overflow-y-auto bg-panel border border-neutral-200 rounded-[4px] shadow-[0_12px_28px_-8px_rgba(24,27,32,0.22),0_2px_6px_rgba(24,27,32,0.08)] px-4 py-3">
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-body text-[14px] font-semibold text-neutral-900">Definitions</h2>
              <button
                onClick={() => setDefsOpen(false)}
                className="appearance-none border-none bg-transparent font-body text-[12px] text-neutral-500 cursor-pointer"
              >
                Close
              </button>
            </div>
            {metas.map((m) => (
              <div key={m.id} className="border-b border-neutral-100 py-2">
                <div className="flex items-center gap-3 font-body text-[12px] text-neutral-700">
                  {canEdit ? (
                    <input
                      key={`${m.id}-${m.name}`}
                      defaultValue={m.name}
                      aria-label={`Rename ${m.name}`}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                      }}
                      onBlur={(e) => {
                        const name = e.currentTarget.value.trim();
                        if (name && name !== m.name) {
                          void patchDefinition(m.id, { name });
                        } else {
                          e.currentTarget.value = m.name;
                        }
                      }}
                      className="w-[150px] border border-neutral-200 bg-panel rounded-[3px] px-1.5 py-0.5 font-body text-[12px] text-neutral-900"
                    />
                  ) : (
                    <span className="text-neutral-900">{m.name}</span>
                  )}
                  {canEdit ? (
                    <button
                      onClick={() => void patchDefinition(m.id, { enabled: !m.enabled })}
                      disabled={busy !== null}
                      className={`appearance-none cursor-pointer bg-transparent disabled:opacity-40 ${enabledPillClass(m.enabled)}`}
                    >
                      {m.enabled ? "Enabled" : "Disabled"}
                    </button>
                  ) : (
                    <span className={enabledPillClass(m.enabled)}>
                      {m.enabled ? "Enabled" : "Disabled"}
                    </span>
                  )}
                  {canEdit && (
                    <span className="ml-auto">
                      {confirmDelete === m.id ? (
                        <>
                          <button
                            onClick={() => void deleteDefinition(m.id)}
                            disabled={busy !== null}
                            className="appearance-none border-none bg-transparent font-body text-[12px] font-semibold text-red-600 cursor-pointer disabled:opacity-40"
                          >
                            {busy === `delete-${m.id}` ? "Deleting…" : "Confirm delete"}
                          </button>
                          <button
                            onClick={() => setConfirmDelete(null)}
                            className="appearance-none border-none bg-transparent font-body text-[12px] text-neutral-500 cursor-pointer ml-2"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => setConfirmDelete(m.id)}
                          disabled={m.enabled}
                          title={m.enabled ? "disable first" : undefined}
                          className="appearance-none border-none bg-transparent font-body text-[12px] text-red-600 cursor-pointer disabled:opacity-40 disabled:cursor-default"
                        >
                          Delete
                        </button>
                      )}
                    </span>
                  )}
                </div>
                {rowError?.id === m.id && (
                  <div className="mt-1 font-body text-[11px] text-red-600">{rowError.message}</div>
                )}
              </div>
            ))}
            {canEdit && (
              <div className="pt-3">
                <div className="font-body text-[12px] font-semibold text-neutral-900 mb-2">
                  New definition
                </div>
                <div className="flex items-center gap-2">
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Name"
                    aria-label="New definition name"
                    className="flex-1 min-w-0 border border-neutral-200 bg-panel rounded-[3px] px-1.5 py-1 font-body text-[12px] text-neutral-900"
                  />
                  <div className="w-[160px]">
                    <Listbox
                      options={[
                        { value: "default", label: "Built-in default" },
                        ...metas.map((m) => ({
                          value: String(m.id),
                          label: `Duplicate: ${m.name}`,
                        })),
                      ]}
                      value={newSource}
                      onChange={setNewSource}
                      disabled={busy !== null}
                      ariaLabel="New definition source"
                    />
                  </div>
                  <button
                    onClick={() => void createDefinition()}
                    disabled={busy !== null || newName.trim().length === 0}
                    className="appearance-none cursor-pointer border border-mariner bg-mariner text-white py-1 px-2.5 rounded-[3px] font-mono text-[11px] tracking-[0.04em] uppercase disabled:opacity-40 disabled:cursor-default"
                  >
                    {busy === "create" ? "Creating…" : "Create"}
                  </button>
                </div>
                {createError && (
                  <div className="mt-1 font-body text-[11px] text-red-600">{createError}</div>
                )}
              </div>
            )}
          </div>
        )}
        {historyOpen && (
          <div className="absolute right-4 top-[56px] z-[60] w-[380px] max-h-[60vh] overflow-y-auto bg-panel border border-neutral-200 rounded-[4px] shadow-[0_12px_28px_-8px_rgba(24,27,32,0.22),0_2px_6px_rgba(24,27,32,0.08)] px-4 py-3">
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-body text-[14px] font-semibold text-neutral-900">History</h2>
              <button
                onClick={() => setHistoryOpen(false)}
                className="appearance-none border-none bg-transparent font-body text-[12px] text-neutral-500 cursor-pointer"
              >
                Close
              </button>
            </div>
            {versions.length === 0 && (
              <div className="font-body text-[12px] text-neutral-500">No versions yet.</div>
            )}
            {deployments.map((deployment) => (
              <div
                key={deployment.id}
                className="flex items-center gap-2 border-b border-neutral-100 py-2 font-body text-[11px] text-neutral-600"
              >
                <span className="font-mono uppercase">{deployment.action}</span>
                <span>v{deployment.selectedVersion}</span>
                {deployment.previousVersion !== null && (
                  <span className="text-neutral-400">from v{deployment.previousVersion}</span>
                )}
                <span className="ml-auto text-neutral-400">
                  {new Date(deployment.createdAt).toLocaleString()}
                </span>
              </div>
            ))}
            {versions.length > 0 && (
              <div className="mt-3 font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-500">
                Snapshots
              </div>
            )}
            {versions.map((v) => (
              <div
                key={v.version}
                className="flex items-center gap-3 border-b border-neutral-100 py-2 font-body text-[12px] text-neutral-700"
              >
                <span className="font-mono text-neutral-900">v{v.version}</span>
                {v.version === deployed?.version && (
                  <span className="rounded-[3px] bg-emerald-50 px-[6px] py-[2px] font-mono text-[10px] text-emerald-700">
                    deployed
                  </span>
                )}
                <span>{v.createdByLabel}</span>
                <span className="text-neutral-400">{new Date(v.createdAt).toLocaleString()}</span>
                {v.restoredFromVersion !== null && (
                  <span className="rounded-[3px] bg-app-bg px-[6px] py-[2px] font-mono text-[10px] text-neutral-600">
                    restored from v{v.restoredFromVersion}
                  </span>
                )}
                {canEdit && v.version !== deployed?.version && (
                  <span className="ml-auto">
                    {confirmRestore === v.version ? (
                      <>
                        <button
                          onClick={() => rollback(v.version)}
                          disabled={busy !== null}
                          className="appearance-none border-none bg-transparent font-body text-[12px] font-semibold text-red-600 cursor-pointer disabled:opacity-40"
                        >
                          {busy === `rollback-${v.version}` ? "Rolling back…" : "Confirm rollback"}
                        </button>
                        <button
                          onClick={() => setConfirmRestore(null)}
                          className="appearance-none border-none bg-transparent font-body text-[12px] text-neutral-500 cursor-pointer ml-2"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setConfirmRestore(v.version)}
                        className="appearance-none border-none bg-transparent font-body text-[12px] text-mariner cursor-pointer"
                      >
                        Roll back
                      </button>
                    )}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
