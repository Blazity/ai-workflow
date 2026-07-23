"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isTriggerBlockType,
  type RunBlockStatusesResponse,
  type WorkflowDefinition,
  type WorkflowDefinitionDeploymentResponse,
  type WorkflowDefinitionDeploymentValidationResponse,
  type WorkflowDefinitionDetailResponse,
  type WorkflowDefinitionLayoutResponse,
  type WorkflowDefinitionMeta,
  type WorkflowDefinitionTemplate,
  type WorkflowDefinitionSaveResponse,
  type WorkflowDefinitionValidationResponse,
  type WorkflowDefinitionVersion,
  type WorkflowExecutionBudgets,
  type WorkflowEditorOptions,
} from "@shared/contracts";
import { FlowEditor } from "@/components/cockpit/flow-editor/flow-editor";
import { PromptLibraryProvider } from "@/components/cockpit/flow-editor/prompt-library-context";
import { HarnessProfileCatalogProvider } from "@/components/cockpit/flow-editor/harness-profile-context";
import { Listbox } from "@/components/cockpit/listbox";
import {
  toFlowDefinition,
  type FlowEdgeDef,
  type FlowNodeDef,
} from "@/lib/flows";
import { readErrorMessage } from "@/lib/api/error-message";
import {
  serializeSemanticWorkflowDefinition,
  serializeWorkflowDefinition,
  serializeWorkflowLayoutWithBaseline,
} from "@/lib/workflow-editor/serialize";
import { deriveRunStatuses } from "@/lib/workflow-editor/run-statuses";
import {
  reduceDefinitionSwitch,
  type DefinitionSwitchState,
} from "@/lib/workflow-editor/definition-switch";
import {
  afterInvalidatingLayoutSave,
  afterPendingLayoutSave,
  createPendingLayoutSave,
  type PendingLayoutSave,
} from "@/lib/workflow-editor/layout-save";
import {
  createWorkflowValidationController,
  type WorkflowValidationController,
  type WorkflowValidationState,
} from "@/lib/workflow-editor/validation-controller";
import {
  workflowDeploymentAfterSave,
  workflowEditorActions,
} from "@/lib/workflow-editor/editor-actions";
import { executionLimitsFromDefinition } from "@/lib/workflow-editor/execution-limits";
import {
  createEditorResponseGuard,
  type EditorResponseGuard,
} from "@/lib/workflow-editor/response-guard";

interface ValidationRequest {
  definitionId: number;
  definition: WorkflowDefinition;
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
  templates,
  initialDetail,
  defaultDefinition,
  options,
  liveBlocks,
  canEdit,
  initialNodeId,
}: {
  definitions: WorkflowDefinitionMeta[];
  templates: WorkflowDefinitionTemplate[];
  initialDetail: WorkflowDefinitionDetailResponse;
  defaultDefinition: WorkflowDefinition;
  options: WorkflowEditorOptions;
  liveBlocks: RunBlockStatusesResponse;
  canEdit: boolean;
  initialNodeId?: string;
}) {
  const seed = initialDetail.draft ?? initialDetail.deployed?.definition ?? defaultDefinition;
  const seedFlow = toFlowDefinition(seed);
  const [metas, setMetas] = useState<WorkflowDefinitionMeta[]>(definitions);
  const [selectedId, setSelectedId] = useState(initialDetail.meta.id);
  const [versions, setVersions] = useState<WorkflowDefinitionVersion[]>(initialDetail.versions);
  const [deployed, setDeployed] = useState<WorkflowDefinitionVersion | null>(initialDetail.deployed);
  const [baselineDraft, setBaselineDraft] = useState<WorkflowDefinition | null>(initialDetail.draft);
  const [schemaVersion, setSchemaVersion] = useState<1 | 2>(seed.schemaVersion);
  const [budgets, setBudgets] = useState<WorkflowExecutionBudgets>(() =>
    executionLimitsFromDefinition(seed),
  );
  const [layoutBaseline, setLayoutBaseline] = useState(() => JSON.stringify(initialDetail.layout));
  const [nodes, setNodes] = useState<FlowNodeDef[]>(() => seedFlow.nodes);
  const [edges, setEdges] = useState<FlowEdgeDef[]>(() => seedFlow.edges);
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
  const [newSource, setNewSource] = useState(`template:${templates[0]?.id ?? "ticket-workflow"}`);
  const [validation, setValidation] = useState<{
    key: string | null;
    state: WorkflowValidationState;
  }>({
    key: null,
    state: {
      status: "checking",
      issues: [],
      nodeContracts: {},
      availableValuesByNode: {},
    },
  });
  const pendingLayoutSaveRef = useRef<PendingLayoutSave | null>(null);
  if (pendingLayoutSaveRef.current === null) {
    pendingLayoutSaveRef.current = createPendingLayoutSave();
  }
  const pendingLayoutSave = pendingLayoutSaveRef.current;
  const editorResponseGuardRef = useRef<EditorResponseGuard | null>(null);
  if (editorResponseGuardRef.current === null) {
    editorResponseGuardRef.current = createEditorResponseGuard();
  }
  const editorResponseGuard = editorResponseGuardRef.current;
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
  const handleSelectionChange = useCallback(
    (nodeId: string | null) => validationController.setFocused(nodeId !== null),
    [validationController],
  );

  // Deep-link preselect is first-load only. FlowEditor is remounted on definition
  // switch (key={selectedId}), so hold the node id in a ref and clear it after the
  // first render consumes it; later definitions must not re-apply the deep link.
  const deepLinkNodeId = useRef(initialNodeId);
  useEffect(() => {
    deepLinkNodeId.current = undefined;
  }, []);

  const selectedMeta = metas.find((m) => m.id === selectedId);
  const semanticDefinition = useMemo(
    () => serializeSemanticWorkflowDefinition(nodes, edges, budgets, schemaVersion),
    [budgets, edges, nodes, schemaVersion],
  );
  const semanticDefinitionRef = useRef(semanticDefinition);
  semanticDefinitionRef.current = semanticDefinition;
  const semanticKey = JSON.stringify(semanticDefinition);
  const baselineSemanticKey =
    baselineDraft === null
      ? null
      : (() => {
          const baselineFlow = toFlowDefinition(baselineDraft);
          return JSON.stringify(
            serializeSemanticWorkflowDefinition(
              baselineFlow.nodes,
              baselineFlow.edges,
              executionLimitsFromDefinition(baselineDraft),
              baselineDraft.schemaVersion,
            ),
          );
        })();
  const validationTargetKey = `${selectedId}:${semanticKey}`;
  const validationIsCurrent = validation.key === validationTargetKey;
  const dirty =
    baselineSemanticKey === null ||
    semanticKey !== baselineSemanticKey;
  const { canSave, canDeploy } = workflowEditorActions({
    dirty,
    structurallyValid: nodesValid(nodes),
    hasDraft: baselineDraft !== null,
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
    if (selectedMeta) pendingLayoutSave.reset(selectedMeta.layoutRevision);
  }, [pendingLayoutSave, selectedId, selectedMeta]);

  useEffect(() => {
    if (!canEdit || !selectedMeta) {
      pendingLayoutSave.discard();
      return;
    }
    const layout = serializeWorkflowLayoutWithBaseline(
      nodes,
      JSON.parse(layoutBaseline) as WorkflowDefinitionLayoutResponse["layout"],
    );
    const serialized = JSON.stringify(layout);
    if (serialized === layoutBaseline) {
      pendingLayoutSave.discard();
      return;
    }
    const definitionId = selectedId;
    pendingLayoutSave.schedule(async (expectedLayoutRevision) => {
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
        return body.meta.layoutRevision;
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

  function applySave(
    res: WorkflowDefinitionSaveResponse,
    refit: boolean,
    replaceEditorState = true,
  ) {
    setBaselineDraft(res.draft);
    if (replaceEditorState) {
      const flow = toFlowDefinition(res.draft);
      setSchemaVersion(flow.schemaVersion);
      setBudgets(executionLimitsFromDefinition(res.draft));
      setNodes(flow.nodes);
      setEdges(flow.edges);
    }
    setMetas((prev) => prev.map((m) => (m.id === res.meta.id ? res.meta : m)));
    if (replaceEditorState) {
      const savedFlow = toFlowDefinition(res.draft);
      const savedKey = `${res.meta.id}:${JSON.stringify(
        serializeSemanticWorkflowDefinition(
          savedFlow.nodes,
          savedFlow.edges,
          executionLimitsFromDefinition(res.draft),
          savedFlow.schemaVersion,
        ),
      )}`;
      validationKeyRef.current = savedKey;
      setValidation({
        key: savedKey,
        state: res.validation
          ? {
              status: res.validation.valid ? "valid" : "invalid",
              issues: res.validation.issues,
              nodeContracts: res.validation.nodeContracts,
              availableValuesByNode: res.validation.availableValuesByNode,
            }
          : {
              status: "error",
              issues: [
                {
                  code: "deployment",
                  severity: "error",
                  nodeId: null,
                  message: res.validationError ?? "Unable to validate the saved draft",
                },
              ],
              nodeContracts: {},
              availableValuesByNode: {},
            },
      });
    }
    if (refit && replaceEditorState) setFitSignal((s) => s + 1);
  }

  function showValidationActionError(
    code: "validation.transport" | "validation.superseded",
    message: string,
  ) {
    const key = validationKeyRef.current ?? validationTargetKey;
    validationKeyRef.current = key;
    setValidation({
      key,
      state: {
        status: "error",
        issues: [{ code, severity: "error", nodeId: null, message }],
        nodeContracts: {},
        availableValuesByNode: {},
      },
    });
  }

  async function save() {
    const requestRevision = editorResponseGuard.capture();
    const definition = serializeWorkflowDefinition(
      nodes,
      edges,
      budgets,
      schemaVersion,
    );
    setBusy("save");
    setError(null);
    try {
      // Save is intentionally fail-open for deployment validation: an outage
      // must not discard an editable, structurally valid draft.
      await validationController
        .validateNow({ definitionId: selectedId, definition })
        .catch(() => undefined);
      await afterPendingLayoutSave(pendingLayoutSave, async () => {
        const res = await fetch(`/api/workflow-definitions/${selectedId}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            definition,
            expectedDraftRevision: selectedMeta?.draftRevision ?? 0,
          }),
        });
        if (!res.ok) {
          setError(await readErrorMessage(res));
          return;
        }
        const saved = (await res.json()) as WorkflowDefinitionSaveResponse;
        const responseIsCurrent = editorResponseGuard.isCurrent(requestRevision);
        applySave(
          saved,
          false,
          responseIsCurrent,
        );
        if (!responseIsCurrent) {
          showValidationActionError(
            "validation.superseded",
            "The workflow changed while it was being saved. Save again to validate the latest changes.",
          );
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save changes");
    } finally {
      setBusy(null);
    }
  }

  async function deploy() {
    if (!selectedMeta) return;
    const requestRevision = editorResponseGuard.capture();
    const definition = serializeWorkflowDefinition(
      nodes,
      edges,
      budgets,
      schemaVersion,
    );
    const candidateKey = validationTargetKey;
    setBusy("deploy");
    setError(null);
    try {
      let immediateValidation: WorkflowDefinitionValidationResponse;
      try {
        immediateValidation = await validationController.validateNow({
          definitionId: selectedId,
          definition,
        });
      } catch (validationFailure) {
        const superseded = !editorResponseGuard.isCurrent(requestRevision);
        showValidationActionError(
          superseded ? "validation.superseded" : "validation.transport",
          superseded
            ? "The workflow changed while it was being validated. Deploy again."
            : validationFailure instanceof Error
              ? validationFailure.message
              : "Unable to validate workflow",
        );
        return;
      }
      if (!immediateValidation.valid) return;
      if (!editorResponseGuard.isCurrent(requestRevision)) {
        showValidationActionError(
          "validation.superseded",
          "The workflow changed while it was being validated. Deploy again.",
        );
        return;
      }

      let draftRevision = selectedMeta.draftRevision;
      let deployedVersion = selectedMeta.deployedVersion;
      if (dirty) {
        const saveRes = await fetch(`/api/workflow-definitions/${selectedId}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            definition,
            expectedDraftRevision: draftRevision,
          }),
        });
        if (!saveRes.ok) {
          setError(await readErrorMessage(saveRes));
          return;
        }
        const saved = (await saveRes.json()) as WorkflowDefinitionSaveResponse;
        const responseIsCurrent = editorResponseGuard.isCurrent(requestRevision);
        applySave(saved, false, responseIsCurrent);
        if (!responseIsCurrent) {
          showValidationActionError(
            "validation.superseded",
            "The workflow changed while it was being saved. Deploy again.",
          );
          return;
        }
        const saveDecision = workflowDeploymentAfterSave(immediateValidation, saved);
        if (saveDecision.kind !== "ready") return;
        draftRevision = saved.meta.draftRevision;
        deployedVersion = saved.meta.deployedVersion;
      }

      const res = await fetch(`/api/workflow-definitions/${selectedId}/deploy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedDraftRevision: draftRevision,
          expectedDeployedVersion: deployedVersion,
        }),
      });
      if (!res.ok) {
        if (res.status === 422) {
          const body = (await res.json()) as WorkflowDefinitionDeploymentValidationResponse;
          validationKeyRef.current = candidateKey;
          setValidation({
            key: candidateKey,
            state: {
              status: "invalid",
              issues: body.issues,
              nodeContracts: immediateValidation.nodeContracts,
              availableValuesByNode: immediateValidation.availableValuesByNode,
            },
          });
          return;
        }
        setError(await readErrorMessage(res));
        return;
      }
      const body = (await res.json()) as WorkflowDefinitionDeploymentResponse;
      setDeployed(body.deployed);
      setVersions((prev) => [body.deployed, ...prev.filter((item) => item.version !== body.deployed.version)]);
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
      setMetas((prev) => prev.map((meta) => (meta.id === body.meta.id ? body.meta : meta)));
      setConfirmRestore(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to roll back version");
    } finally {
      setBusy(null);
    }
  }

  async function applySwitch(targetId: number, requestRevision: number) {
    setBusy("switch");
    setError(null);
    try {
      const res = await fetch(`/api/workflow-definitions/${targetId}`);
      if (!res.ok) {
        setError(await readErrorMessage(res));
        return;
      }
      const detail = (await res.json()) as WorkflowDefinitionDetailResponse;
      if (!editorResponseGuard.isCurrent(requestRevision)) {
        setError(
          "The workflow changed while the definition was loading. Switch again to discard the newer edits.",
        );
        return;
      }
      setSelectedId(detail.meta.id);
      setMetas((prev) => prev.map((m) => (m.id === detail.meta.id ? detail.meta : m)));
      setVersions(detail.versions);
      setDeployed(detail.deployed);
      setBaselineDraft(detail.draft);
      setLayoutBaseline(JSON.stringify(detail.layout));
      const def = detail.draft ?? detail.deployed?.definition ?? defaultDefinition;
      const flow = toFlowDefinition(def);
      setSchemaVersion(flow.schemaVersion);
      setBudgets(executionLimitsFromDefinition(def));
      setNodes(flow.nodes);
      setEdges(flow.edges);
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
      const requestRevision = editorResponseGuard.capture();
      await afterPendingLayoutSave(pendingLayoutSave, () =>
        applySwitch(t.switchTo!, requestRevision),
      );
    }
  }

  async function confirmSwitch() {
    const t = reduceDefinitionSwitch(switchState, { type: "confirm" });
    setSwitchState(t.state);
    if (t.switchTo !== null) {
      const requestRevision = editorResponseGuard.capture();
      await afterPendingLayoutSave(pendingLayoutSave, () =>
        applySwitch(t.switchTo!, requestRevision),
      );
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
      if (id === selectedId && remaining[0]) {
        await afterInvalidatingLayoutSave(pendingLayoutSave, () =>
          applySwitch(remaining[0].id, editorResponseGuard.capture()),
        );
      }
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
        newSource.startsWith("template:")
          ? { kind: "template" as const, templateId: newSource.slice("template:".length) }
          : { kind: "duplicate" as const, definitionId: Number(newSource.slice("duplicate:".length)) };
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
      setNewSource(`template:${templates[0]?.id ?? "ticket-workflow"}`);
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

  const triggerLabel = (type: WorkflowDefinitionMeta["triggerTypes"][number]) =>
    options.blockRegistry[type]?.presentation.label ?? type;

  return (
    <HarnessProfileCatalogProvider>
    <PromptLibraryProvider>
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
          definitionId={selectedId}
          nodes={nodes}
          edges={edges}
          schemaVersion={schemaVersion}
          limits={budgets}
          onLimitsChange={(next) => {
            editorResponseGuard.invalidate();
            setBudgets(next);
          }}
          onNodesChange={(next) => {
            editorResponseGuard.invalidate();
            setNodes(next);
          }}
          onEdgesChange={(next) => {
            editorResponseGuard.invalidate();
            setEdges(next);
          }}
          canEdit={canEdit}
          dirty={dirty}
          saveEnabled={canSave}
          saving={busy === "save"}
          error={error}
          validation={
            validationIsCurrent
              ? validation.state
              : {
                  status: "checking",
                  issues: [],
                  nodeContracts: {},
                  availableValuesByNode: {},
                }
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
              <button
                onClick={() => {
                  setDefsOpen((o) => !o);
                  setHistoryOpen(false);
                }}
                className={`${headerButtonClass} min-w-[190px] max-w-[260px] flex items-center justify-between gap-3 normal-case tracking-normal`}
                aria-expanded={defsOpen}
              >
                <span className="truncate">{selectedMeta?.name ?? "Workflows"}</span>
                <span className="text-neutral-500 shrink-0">{metas.length} ▾</span>
              </button>
              <button
                onClick={() => {
                  setHistoryOpen((o) => !o);
                  setDefsOpen(false);
                }}
                className={headerButtonClass}
              >
                History ({versions.length})
              </button>
            </>
          }
          options={options}
          runStatuses={derived?.statuses}
          runErrors={derived?.errors}
          fitSignal={fitSignal}
          initialSelectedId={deepLinkNodeId.current}
          onSelectionChange={handleSelectionChange}
        />
        {defsOpen && (
          <div className="absolute right-4 top-[56px] z-[60] w-[440px] max-h-[70vh] overflow-y-auto bg-panel border border-neutral-200 rounded-[4px] shadow-[0_12px_28px_-8px_rgba(24,27,32,0.22),0_2px_6px_rgba(24,27,32,0.08)] px-4 py-3">
            <div className="flex items-center justify-between mb-1">
              <div>
                <h2 className="font-body text-[14px] font-semibold text-neutral-900">Workflows</h2>
                <p className="mt-0.5 font-body text-[11px] text-neutral-500">
                  Switch, activate, rename, or create workflows here.
                </p>
              </div>
              <button
                onClick={() => setDefsOpen(false)}
                className="appearance-none border-none bg-transparent font-body text-[12px] text-neutral-500 cursor-pointer"
              >
                Close
              </button>
            </div>
            {metas.map((m) => (
              <div
                key={m.id}
                className={`border-b border-neutral-100 py-2.5 ${m.id === selectedId ? "bg-app-bg -mx-2 px-2" : ""}`}
              >
                <div className="flex items-start gap-3 font-body text-[12px] text-neutral-700">
                  <button
                    onClick={() => {
                      void requestSwitch(m.id);
                      setDefsOpen(false);
                    }}
                    disabled={busy !== null || m.id === selectedId}
                    className="appearance-none min-w-0 flex-1 border-none bg-transparent p-0 text-left cursor-pointer disabled:cursor-default"
                  >
                    <span className="flex items-center gap-2 text-neutral-900 font-semibold">
                      <span className="truncate">{m.name}</span>
                      {m.id === selectedId && (
                        <span className="font-mono text-[9px] uppercase tracking-[0.05em] text-mariner">
                          Current
                        </span>
                      )}
                    </span>
                    <span className="mt-1 flex flex-wrap gap-1">
                      {m.triggerTypes.length === 0 ? (
                        <span className="text-[11px] text-neutral-500">No active triggers</span>
                      ) : (
                        m.triggerTypes.map((trigger) => (
                          <span
                            key={trigger}
                            className="rounded-[3px] border border-neutral-200 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.04em] text-neutral-600"
                          >
                            {triggerLabel(trigger)}
                          </span>
                        ))
                      )}
                    </span>
                  </button>
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
                </div>
                {canEdit && (
                  <div className="mt-2 flex items-center gap-2 pl-0 font-body text-[12px] text-neutral-700">
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
                      className="flex-1 min-w-0 border border-neutral-200 bg-panel rounded-[3px] px-1.5 py-0.5 font-body text-[12px] text-neutral-900"
                    />
                    <span className="shrink-0">
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
                  </div>
                )}
                {rowError?.id === m.id && (
                  <div className="mt-1 font-body text-[11px] text-red-600">{rowError.message}</div>
                )}
              </div>
            ))}
            {canEdit && (
              <div className="pt-3">
                <div className="font-body text-[12px] font-semibold text-neutral-900 mb-2">
                  New workflow
                </div>
                <div className="flex items-center gap-2">
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Name"
                    aria-label="New workflow name"
                    className="flex-1 min-w-0 border border-neutral-200 bg-panel rounded-[3px] px-1.5 py-1 font-body text-[12px] text-neutral-900"
                  />
                  <div className="w-[160px]">
                    <Listbox
                      options={[
                        ...templates.map((template) => ({
                          value: `template:${template.id}`,
                          label: template.name,
                          hint: "template",
                        })),
                        ...metas.map((m) => ({
                          value: `duplicate:${m.id}`,
                          label: `Duplicate: ${m.name}`,
                        })),
                      ]}
                      value={newSource}
                      onChange={setNewSource}
                      disabled={busy !== null}
                      ariaLabel="New workflow source"
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
    </PromptLibraryProvider>
    </HarnessProfileCatalogProvider>
  );
}
