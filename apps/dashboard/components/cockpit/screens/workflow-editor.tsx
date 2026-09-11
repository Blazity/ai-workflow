"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { CircleIcon } from "@phosphor-icons/react/dist/csr/Circle";
import {
  isManuallyDispatchableTrigger,
  isTriggerBlockType,
  RETIRED_SCHEMA_MESSAGE,
  type RunBlockStatusesResponse,
  type WorkflowDefinition,
  type WorkflowDefinitionDeploymentValidationResponse,
  type WorkflowDefinitionDetailResponse,
  type WorkflowDefinitionLayoutResponse,
  type WorkflowDefinitionMeta,
  type WorkflowDefinitionTemplate,
  type WorkflowDefinitionSaveResponse,
  type WorkflowDefinitionValidationResponse,
  type WorkflowDefinitionVersion,
  type WorkflowEdgeGeometry,
  type WorkflowExecutionBudgets,
  type WorkflowEditorOptions,
  type WorkflowRepositoryScope,
} from "@shared/contracts";
import { FlowEditor } from "@/components/cockpit/flow-editor/flow-editor";
import { PromptLibraryProvider } from "@/components/cockpit/flow-editor/prompt-library-context";
import { HarnessProfileCatalogProvider } from "@/components/cockpit/flow-editor/harness-profile-context";
import { RepositoryCatalogProvider } from "@/components/cockpit/flow-editor/repository-catalog-context";
import { Listbox } from "@/components/cockpit/listbox";
import { ManualDispatchModal } from "@/components/cockpit/manual-dispatch-modal";
import {
  runnableVersionDefinition,
  toFlowDefinition,
  type FlowEdgeDef,
  type FlowNodeDef,
} from "@/lib/flows";
import { apiClient } from "@/lib/api/client";
import {
  serializeSemanticWorkflowDefinition,
  serializeWorkflowDefinition,
  serializeWorkflowLayoutWithBaseline,
} from "@/lib/workflow-editor/serialize";
import { deriveRunStatuses } from "@/lib/workflow-editor/run-statuses";
import { isRepositoryScriptGroupName } from "@/lib/workflow-editor/params";
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
  type WorkflowValidationState,
} from "@/lib/workflow-editor/validation-controller";
import { useWorkflowValidationController } from "@/lib/workflow-editor/use-validation-controller";
import { useWorkflowDataCatalog } from "@/lib/workflow-editor/use-workflow-data-catalog";
import {
  draftDiffersFromDeployed,
  workflowDeploymentAfterSave,
  workflowEditorActions,
} from "@/lib/workflow-editor/editor-actions";
import { executionLimitsFromDefinition } from "@/lib/workflow-editor/execution-limits";
import {
  describeRepositoryScope,
  repositoryScopeFromDefinition,
} from "@/lib/workflow-editor/repository-scope";
import {
  createEditorResponseGuard,
  type EditorResponseGuard,
} from "@/lib/workflow-editor/response-guard";
import {
  createEditorHistory,
  editorHistoryCanRedo,
  editorHistoryCanUndo,
  editorHistoryIsDirty,
  reduceEditorHistory,
  type EditorHistoryAction,
  type EditorHistoryState,
} from "@/lib/workflow-editor/history";

interface ValidationRequest {
  definitionId: number;
  definition: WorkflowDefinition;
}

interface WorkflowEditorDocument {
  nodes: FlowNodeDef[];
  edges: FlowEdgeDef[];
  budgets: WorkflowExecutionBudgets;
  repositoryScope: WorkflowRepositoryScope;
  edgeGeometry: Record<string, WorkflowEdgeGeometry>;
}

function semanticKeyForDefinition(definition: WorkflowDefinition): string {
  const flow = toFlowDefinition(definition);
  return JSON.stringify(
    serializeSemanticWorkflowDefinition(
      flow.nodes,
      flow.edges,
      executionLimitsFromDefinition(definition),
      repositoryScopeFromDefinition(definition),
    ),
  );
}

function semanticKeyForDocument(document: WorkflowEditorDocument): string {
  return JSON.stringify(
    serializeSemanticWorkflowDefinition(
      document.nodes,
      document.edges,
      document.budgets,
      document.repositoryScope,
    ),
  );
}

export const RETIRED_DEPLOYED_NOTE =
  "The deployed version of this definition uses the retired schema v1 and cannot run. The editor shows the built-in ticket workflow as a starting draft; nothing is saved until you save, and publishing the new draft replaces the retired version.";

export function legacyVersionDisclosureKey(
  definitionId: number,
  version: number,
): string {
  return `${definitionId}:${version}`;
}

export function initialEditorSavedSemanticKey(
  detail: WorkflowDefinitionDetailResponse,
  seed: WorkflowDefinition,
): string | null {
  if (detail.draft) return semanticKeyForDefinition(detail.draft);
  return detail.deployed?.schema === "legacy-v1"
    ? semanticKeyForDefinition(seed)
    : null;
}

export function legacyVersionToggleLabel(expanded: boolean): string {
  return expanded ? "Hide stored JSON" : "Show stored JSON";
}

export function prettyStoredWorkflowDefinition(raw: unknown): string {
  return JSON.stringify(raw, null, 2) ?? String(raw);
}

export interface WorkflowNodeSaveIssue {
  nodeId: string;
  message: string;
}

/** Per-node reasons Save is disabled, each mirroring a rule the server already
 *  enforces. Returned as a list rather than a boolean so the header can name
 *  the offending block and jump to it, instead of leaving an author to hunt a
 *  greyed-out button across the canvas. */
export function nodeSaveIssues(nodes: FlowNodeDef[]): WorkflowNodeSaveIssue[] {
  const issues: WorkflowNodeSaveIssue[] = [];
  for (const node of nodes) {
    if (node.type === "update_ticket_status" && typeof node.params.target !== "string") {
      issues.push({ nodeId: node.id, message: "Pick a target ticket status." });
    }
    // run_pre_pr_checks.maxFixCycles used to be range-checked here, but the
    // repair loop it configured is gone and the panel no longer offers a
    // field to fix an out-of-range value: validating it just locked Save
    // forever for a legacy definition, with no editor to unlock it.
    if (node.type === "run_scripts") {
      // Mirrors v2RunScriptsConfiguration: at least one group, every name a
      // legal one. Without it the rule only fired at Deploy, as a raw zod path.
      const groups = node.params.groups;
      const names = Array.isArray(groups)
        ? groups.filter((value): value is string => typeof value === "string")
        : [];
      if (names.length === 0) {
        issues.push({ nodeId: node.id, message: "Select at least one script group." });
      } else if (!names.every(isRepositoryScriptGroupName)) {
        issues.push({ nodeId: node.id, message: "A selected group name is not a legal name." });
      }
    }
    if (node.type === "run_checks") {
      // Mirrors the server's superRefine: commands and groups are mutually
      // exclusive, and without this check an author filling both keeps an
      // enabled Save and only learns at publish time.
      const commands = node.params.commands;
      const groups = node.params.groups;
      const hasCommands = Array.isArray(commands) && commands.length > 0;
      const names = Array.isArray(groups)
        ? groups.filter((value): value is string => typeof value === "string")
        : [];
      if (hasCommands && names.length > 0) {
        issues.push({ nodeId: node.id, message: "Commands and Groups are both set." });
      } else if (Array.isArray(groups) && names.length === 0) {
        // A present-but-empty list is the Named selection mode with nothing
        // picked. The server refuses it too (groups is min(1) when present),
        // so Save blocks here rather than letting Deploy report a zod path.
        issues.push({
          nodeId: node.id,
          message: "Named groups selected but none picked.",
        });
      } else if (!names.every(isRepositoryScriptGroupName)) {
        issues.push({ nodeId: node.id, message: "A selected group name is not a legal name." });
      }
    }
  }
  return issues;
}

export function nodesValid(nodes: FlowNodeDef[]): boolean {
  if (!nodes.some((n) => isTriggerBlockType(n.type))) return false;
  return nodeSaveIssues(nodes).length === 0;
}

function isDeploymentValidationResponse(
  value: unknown,
): value is WorkflowDefinitionDeploymentValidationResponse {
  return (
    value !== null &&
    typeof value === "object" &&
    Array.isArray((value as { issues?: unknown }).issues)
  );
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
  canDispatch,
  actorLabel,
  initialNodeId,
}: {
  definitions: WorkflowDefinitionMeta[];
  templates: WorkflowDefinitionTemplate[];
  initialDetail: WorkflowDefinitionDetailResponse;
  defaultDefinition: WorkflowDefinition;
  options: WorkflowEditorOptions;
  liveBlocks: RunBlockStatusesResponse;
  canEdit: boolean;
  canDispatch: boolean;
  actorLabel: string;
  initialNodeId?: string;
}) {
  const seed =
    initialDetail.draft ??
    runnableVersionDefinition(initialDetail.deployed) ??
    defaultDefinition;
  const seedFlow = toFlowDefinition(seed);
  const [metas, setMetas] = useState<WorkflowDefinitionMeta[]>(definitions);
  const [selectedId, setSelectedId] = useState(initialDetail.meta.id);
  const [versions, setVersions] = useState<WorkflowDefinitionVersion[]>(initialDetail.versions);
  const [deployed, setDeployed] = useState<WorkflowDefinitionVersion | null>(initialDetail.deployed);
  const [baselineDraft, setBaselineDraft] = useState<WorkflowDefinition | null>(initialDetail.draft);
  const [editorHistory, dispatchEditorHistory] = useReducer(
    (
      state: EditorHistoryState<WorkflowEditorDocument>,
      action: EditorHistoryAction<WorkflowEditorDocument>,
    ) => reduceEditorHistory(state, action),
    undefined,
    () =>
      createEditorHistory(
        {
          nodes: seedFlow.nodes,
          edges: seedFlow.edges,
          budgets: executionLimitsFromDefinition(seed),
          repositoryScope: repositoryScopeFromDefinition(seed),
          edgeGeometry: structuredClone(initialDetail.layout.edges),
        },
        {
          savedSemanticKey: initialDetail.draft
            ? semanticKeyForDefinition(initialDetail.draft)
            : initialEditorSavedSemanticKey(initialDetail, seed),
        },
      ),
  );
  const { nodes, edges, budgets, repositoryScope, edgeGeometry } =
    editorHistory.present;
  const [layoutBaseline, setLayoutBaseline] = useState(() => JSON.stringify(initialDetail.layout));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expandedLegacyVersions, setExpandedLegacyVersions] = useState<Set<string>>(
    () => new Set(),
  );
  const [fitSignal, setFitSignal] = useState(0);
  const [editorGeneration, setEditorGeneration] = useState(0);
  const [selectionRequest] = useState<{
    nodeId: string;
    requestId: number;
  } | null>(null);
  const [switchState, setSwitchState] = useState<DefinitionSwitchState>({ kind: "idle" });
  const [defsOpen, setDefsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [manualDispatchTrigger, setManualDispatchTrigger] =
    useState<FlowNodeDef | null>(null);
  useEffect(() => setManualDispatchTrigger(null), [selectedId]);
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
      status: "idle",
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
  const editorHistoryRef = useRef(editorHistory);
  editorHistoryRef.current = editorHistory;
  const editorDocumentRef = useRef(editorHistory.present);
  editorDocumentRef.current = editorHistory.present;
  const applyEditorDocument = useCallback(
    (
      update: (
        current: WorkflowEditorDocument,
      ) => WorkflowEditorDocument,
      updateOptions: { semantic?: boolean } = {},
    ) => {
      const next = update(editorDocumentRef.current);
      editorDocumentRef.current = next;
      if (updateOptions.semantic !== false) editorResponseGuard.invalidate();
      dispatchEditorHistory({ type: "apply", value: next });
    },
    [editorResponseGuard],
  );
  const changeNodes = useCallback<
    React.Dispatch<React.SetStateAction<FlowNodeDef[]>>
  >(
    (update) =>
      applyEditorDocument((current) => ({
        ...current,
        nodes:
          typeof update === "function"
            ? update(current.nodes)
            : update,
      })),
    [applyEditorDocument],
  );
  const changeEdges = useCallback<
    React.Dispatch<React.SetStateAction<FlowEdgeDef[]>>
  >(
    (update) =>
      applyEditorDocument((current) => ({
        ...current,
        edges:
          typeof update === "function"
            ? update(current.edges)
            : update,
      })),
    [applyEditorDocument],
  );
  const changeNodePositions = useCallback<
    React.Dispatch<React.SetStateAction<FlowNodeDef[]>>
  >(
    (update) =>
      applyEditorDocument(
        (current) => ({
          ...current,
          nodes:
            typeof update === "function"
              ? update(current.nodes)
              : update,
        }),
        { semantic: false },
      ),
    [applyEditorDocument],
  );
  const changeBudgets = useCallback(
    (next: WorkflowExecutionBudgets) =>
      applyEditorDocument((current) => ({ ...current, budgets: next })),
    [applyEditorDocument],
  );
  const changeRepositoryScope = useCallback(
    (next: WorkflowRepositoryScope) =>
      applyEditorDocument((current) => ({ ...current, repositoryScope: next })),
    [applyEditorDocument],
  );
  const changeEdgeGeometry = useCallback<
    React.Dispatch<
      React.SetStateAction<Record<string, WorkflowEdgeGeometry>>
    >
  >(
    (update) =>
      applyEditorDocument(
        (current) => ({
          ...current,
          edgeGeometry:
            typeof update === "function"
              ? update(current.edgeGeometry)
              : update,
        }),
        { semantic: false },
      ),
    [applyEditorDocument],
  );
  const changeGraph = useCallback(
    (
      next: Pick<
        WorkflowEditorDocument,
        "nodes" | "edges" | "edgeGeometry"
      >,
    ) =>
      applyEditorDocument((current) => ({
        ...current,
        ...next,
      })),
    [applyEditorDocument],
  );
  const beginEditorTransaction = useCallback(() => {
    pendingLayoutSave.discard();
    dispatchEditorHistory({ type: "begin_transaction" });
  }, [pendingLayoutSave]);
  const commitEditorTransaction = useCallback(() => {
    dispatchEditorHistory({ type: "commit_transaction" });
  }, []);
  const cancelEditorTransaction = useCallback(() => {
    const state = editorHistoryRef.current;
    const before = state.transaction?.before;
    if (before) editorDocumentRef.current = before;
    if (
      before &&
      semanticKeyForDocument(before) !==
        semanticKeyForDocument(state.present)
    ) {
      editorResponseGuard.invalidate();
    }
    dispatchEditorHistory({ type: "cancel_transaction" });
  }, [editorResponseGuard]);
  const undoEditor = useCallback(() => {
    const state = editorHistoryRef.current;
    const previous = state.past.at(-1);
    if (previous) editorDocumentRef.current = previous;
    if (
      previous &&
      semanticKeyForDocument(previous) !==
        semanticKeyForDocument(state.present)
    ) {
      editorResponseGuard.invalidate();
    }
    dispatchEditorHistory({ type: "undo" });
  }, [editorResponseGuard]);
  const redoEditor = useCallback(() => {
    const state = editorHistoryRef.current;
    const next = state.future[0];
    if (next) editorDocumentRef.current = next;
    if (
      next &&
      semanticKeyForDocument(next) !==
        semanticKeyForDocument(state.present)
    ) {
      editorResponseGuard.invalidate();
    }
    dispatchEditorHistory({ type: "redo" });
  }, [editorResponseGuard]);
  const validationKeyRef = useRef<string | null>(null);
  const validationControllerRef =
    useWorkflowValidationController<ValidationRequest>({
      validate: async ({ definitionId, definition }, signal) => {
        const res = await apiClient.workflowDefinitions.validate(
          definitionId,
          definition,
          { signal },
        );
        if (!res.ok) throw new Error(res.errorMessage);
        return res.data;
      },
      onState: (state) => setValidation({ key: validationKeyRef.current, state }),
    });
  const handleSelectionChange = useCallback(
    (nodeId: string | null) =>
      validationControllerRef.current?.setFocused(nodeId !== null),
    [],
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
    () =>
      serializeSemanticWorkflowDefinition(
        nodes,
        edges,
        budgets,
        repositoryScope,
      ),
    [budgets, edges, nodes, repositoryScope],
  );
  const semanticDefinitionRef = useRef(semanticDefinition);
  semanticDefinitionRef.current = semanticDefinition;
  const semanticKey = JSON.stringify(semanticDefinition);
  const validationTargetKey = `${selectedId}:${semanticKey}`;
  const validationIsCurrent = validation.key === validationTargetKey;
  const dataCatalog = useWorkflowDataCatalog(selectedId, semanticDefinition);
  const dirty = editorHistoryIsDirty(editorHistory, semanticKey);
  // Independent of `dirty` (canvas vs. saved draft): flags the saved draft no
  // longer matching what is deployed, which a rollback produces without ever
  // touching the canvas or the draft, so `dirty` alone would stay false.
  const deployedSemanticKey = useMemo(
    () => {
      const graph = runnableVersionDefinition(deployed);
      return graph ? semanticKeyForDefinition(graph) : null;
    },
    [deployed],
  );
  const draftSemanticKey = baselineDraft
    ? semanticKeyForDefinition(baselineDraft)
    : null;
  const displayingLegacyRecoverySeed =
    baselineDraft === null && deployed?.schema === "legacy-v1";
  const showDraftDiffersFromDeployed = draftDiffersFromDeployed(
    draftSemanticKey,
    deployedSemanticKey,
  );
  const runnableTriggerIds = useMemo(() => {
    const deployedDefinition = runnableVersionDefinition(deployed);
    if (!canDispatch || !deployedDefinition) return new Set<string>();
    const deployedTypes = new Map(
      deployedDefinition.nodes.map((node) => [node.id, node.type]),
    );
    return new Set(
      nodes
        // Derived from the shared allowlist rather than a deny-list of the
        // triggers that cannot be fired by hand. The deny-list silently offered
        // this button for a schedule, whose modal then asked for a pull request
        // URL and whose worker answered 422 saying the trigger was not deployed,
        // which was not true. Any trigger added without a decision is now absent
        // from the allowlist, so the button is withheld rather than misleading.
        .filter(
          (node) =>
            isManuallyDispatchableTrigger(node.type) &&
            deployedTypes.get(node.id) === node.type,
        )
        .map((node) => node.id),
    );
  }, [canDispatch, deployed, nodes]);
  const saveIssues = useMemo(() => nodeSaveIssues(nodes), [nodes]);
  const { canSave, canDeploy } = workflowEditorActions({
    dirty,
    structurallyValid: nodesValid(nodes),
    hasDraft: baselineDraft !== null,
  });
  const canResetToDeployed =
    canEdit && deployed !== null && semanticKey !== deployedSemanticKey;

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
    validationControllerRef.current?.schedule({
      definitionId: selectedId,
      definition: semanticDefinitionRef.current,
    });
  }, [selectedId, validationTargetKey]);

  useEffect(() => {
    if (selectedMeta) pendingLayoutSave.reset(selectedMeta.layoutRevision);
  }, [pendingLayoutSave, selectedId, selectedMeta]);

  useEffect(() => {
    if (
      !canEdit ||
      !selectedMeta ||
      editorHistory.transaction !== null ||
      displayingLegacyRecoverySeed
    ) {
      pendingLayoutSave.discard();
      return;
    }
    const layout = serializeWorkflowLayoutWithBaseline(
      nodes,
      JSON.parse(layoutBaseline) as WorkflowDefinitionLayoutResponse["layout"],
      edgeGeometry,
    );
    const serialized = JSON.stringify(layout);
    if (serialized === layoutBaseline) {
      pendingLayoutSave.discard();
      return;
    }
    const definitionId = selectedId;
    pendingLayoutSave.schedule(async (expectedLayoutRevision) => {
      try {
        const res = await apiClient.workflowDefinitions.saveLayout(
          definitionId,
          layout,
          expectedLayoutRevision,
        );
        if (!res.ok) {
          setError(res.errorMessage);
          return false;
        }
        const body = res.data;
        setMetas((prev) => prev.map((meta) => (meta.id === body.meta.id ? body.meta : meta)));
        setLayoutBaseline(JSON.stringify(body.layout));
        return body.meta.layoutRevision;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to save layout");
        return false;
      }
    });
  }, [
    canEdit,
    displayingLegacyRecoverySeed,
    edgeGeometry,
    editorHistory.transaction,
    layoutBaseline,
    nodes,
    pendingLayoutSave,
    selectedId,
    selectedMeta,
  ]);

  useEffect(() => () => pendingLayoutSave.discard(), [pendingLayoutSave]);

  const run = liveBlocks.run;
  const derived = deriveRunStatuses(run, {
    definitionId: selectedId,
    version: deployed?.version ?? null,
  });

  let statusBar: React.ReactNode = null;
  if (derived && run) {
    const nodeName = (id: string) => nodes.find((n) => n.id === id)?.name || id;
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
      statusText = err ? `Failed at ${where}: ${err}` : `Failed at ${where}`;
    } else if (warnId) {
      const err = derived.errors[warnId];
      statusText = err
        ? `Awaiting: questions on the ticket: ${err}`
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
        {/* The CSS truncate already keeps this to one line. Cutting the string
            in JS as well took a second bite out of an already-clamped failure
            message, so the bar showed neither the verdict nor the diagnostic ID
            and hover recovered nothing. */}
        <span className="truncate" title={statusText}>
          {statusText}
        </span>
      </div>
    );
  }

  function applySave(
    res: WorkflowDefinitionSaveResponse,
    refit: boolean,
    responseIsCurrent = true,
  ) {
    setBaselineDraft(res.draft);
    setMetas((prev) => prev.map((m) => (m.id === res.meta.id ? res.meta : m)));
    const savedSemanticKey = semanticKeyForDefinition(res.draft);
    const savedValidationKey = `${res.meta.id}:${savedSemanticKey}`;
    dispatchEditorHistory({
      type: "mark_saved",
      savedSemanticKey,
    });
    if (responseIsCurrent) {
      validationKeyRef.current = savedValidationKey;
      setValidation({
        key: savedValidationKey,
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
    if (refit && responseIsCurrent) setFitSignal((s) => s + 1);
  }

  async function save() {
    const requestRevision = editorResponseGuard.capture();
    const definition = serializeWorkflowDefinition(
      nodes,
      edges,
      budgets,
      repositoryScope,
    );
    setBusy("save");
    setError(null);
    try {
      // Save is intentionally fail-open for deployment validation: an outage
      // must not discard an editable, structurally valid draft.
      await afterPendingLayoutSave(pendingLayoutSave, async () => {
        const res = await apiClient.workflowDefinitions.save(
          selectedId,
          definition,
          selectedMeta?.draftRevision ?? 0,
        );
        if (!res.ok) {
          setError(res.errorMessage);
          return;
        }
        const saved = res.data;
        const responseIsCurrent = editorResponseGuard.isCurrent(requestRevision);
        applySave(
          saved,
          false,
          responseIsCurrent,
        );
        if (!responseIsCurrent) {
          setError(
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
      repositoryScope,
    );
    const candidateKey = validationTargetKey;
    setBusy("deploy");
    setError(null);
    try {
      let immediateValidation: WorkflowDefinitionValidationResponse;
      try {
        immediateValidation = await validationControllerRef.current!.validateNow({
          definitionId: selectedId,
          definition,
        });
      } catch (validationFailure) {
        const superseded = !editorResponseGuard.isCurrent(requestRevision);
        setError(
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
        setError(
          "The workflow changed while it was being validated. Deploy again.",
        );
        return;
      }

      let draftRevision = selectedMeta.draftRevision;
      let deployedVersion = selectedMeta.deployedVersion;
      if (dirty) {
        const saveRes = await apiClient.workflowDefinitions.save(
          selectedId,
          definition,
          draftRevision,
        );
        if (!saveRes.ok) {
          setError(saveRes.errorMessage);
          return;
        }
        const saved = saveRes.data;
        const responseIsCurrent = editorResponseGuard.isCurrent(requestRevision);
        applySave(saved, false, responseIsCurrent);
        if (!responseIsCurrent) {
          setError(
            "The workflow changed while it was being saved. Deploy again.",
          );
          return;
        }
        const saveDecision = workflowDeploymentAfterSave(immediateValidation, saved);
        if (saveDecision.kind !== "ready") return;
        draftRevision = saved.meta.draftRevision;
        deployedVersion = saved.meta.deployedVersion;
      }

      const res = await apiClient.workflowDefinitions.deploy(
        selectedId,
        draftRevision,
        deployedVersion,
      );
      if (!res.ok) {
        if (res.status === 422 && isDeploymentValidationResponse(res.error)) {
          const body = res.error;
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
        setError(res.errorMessage);
        return;
      }
      const body = res.data;
      setDeployed(body.deployed);
      setVersions((prev) => [body.deployed, ...prev.filter((item) => item.version !== body.deployed.version)]);
      setMetas((prev) => prev.map((meta) => (meta.id === body.meta.id ? body.meta : meta)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to deploy draft");
    } finally {
      setBusy(null);
    }
  }

  // Rollback and "Reset to deployed" both need the canvas to show a specific,
  // already-known definition instead of whatever the draft last held. The
  // loaded content is compared against the saved draft (not the definition
  // just loaded), so a rollback that lands on a different graph than the
  // draft correctly shows as unsaved rather than being silently treated as
  // the new baseline.
  function loadDefinitionIntoCanvas(definition: WorkflowDefinition) {
    const flow = toFlowDefinition(definition);
    const nextDocument: WorkflowEditorDocument = {
      nodes: flow.nodes,
      edges: flow.edges,
      budgets: executionLimitsFromDefinition(definition),
      repositoryScope: repositoryScopeFromDefinition(definition),
      edgeGeometry: structuredClone(edgeGeometry),
    };
    editorDocumentRef.current = nextDocument;
    dispatchEditorHistory({
      type: "reset",
      value: nextDocument,
      savedSemanticKey: baselineDraft ? semanticKeyForDefinition(baselineDraft) : null,
    });
    setFitSignal((signal) => signal + 1);
  }

  function resetToDeployed() {
    const graph = runnableVersionDefinition(deployed);
    if (!graph) return;
    loadDefinitionIntoCanvas(graph);
  }

  async function rollback(version: number) {
    setBusy(`rollback-${version}`);
    setError(null);
    try {
      const res = await apiClient.workflowDefinitions.rollback(
        selectedId,
        version,
        selectedMeta?.deployedVersion ?? null,
      );
      if (!res.ok) {
        setError(res.errorMessage);
        return;
      }
      const body = res.data;
      setDeployed(body.deployed);
      setMetas((prev) => prev.map((meta) => (meta.id === body.meta.id ? body.meta : meta)));
      const rolledBackTo = runnableVersionDefinition(body.deployed);
      if (rolledBackTo) loadDefinitionIntoCanvas(rolledBackTo);
      setConfirmRestore(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to roll back version");
    } finally {
      setBusy(null);
    }
  }

  function applyAuthoritativeDetail(
    detail: WorkflowDefinitionDetailResponse,
    forceRemount = false,
  ) {
    setSelectedId(detail.meta.id);
    setMetas((prev) =>
      prev.map((meta) => (meta.id === detail.meta.id ? detail.meta : meta)),
    );
    setVersions(detail.versions);
    setDeployed(detail.deployed);
    setBaselineDraft(detail.draft);
    setLayoutBaseline(JSON.stringify(detail.layout));
    const definition =
      detail.draft ??
      runnableVersionDefinition(detail.deployed) ??
      defaultDefinition;
    const flow = toFlowDefinition(definition);
    const nextDocument: WorkflowEditorDocument = {
      nodes: flow.nodes,
      edges: flow.edges,
      budgets: executionLimitsFromDefinition(definition),
      repositoryScope: repositoryScopeFromDefinition(definition),
      edgeGeometry: structuredClone(detail.layout.edges),
    };
    editorDocumentRef.current = nextDocument;
    dispatchEditorHistory({
      type: "reset",
      value: nextDocument,
      savedSemanticKey: initialEditorSavedSemanticKey(detail, definition),
    });
    setConfirmRestore(null);
    setExpandedLegacyVersions(new Set());
    setFitSignal((signal) => signal + 1);
    if (forceRemount) setEditorGeneration((generation) => generation + 1);
  }

  async function applySwitch(targetId: number, requestRevision: number) {
    setBusy("switch");
    setError(null);
    try {
      const res = await apiClient.workflowDefinitions.detail(targetId);
      if (!res.ok) {
        setError(res.errorMessage);
        return;
      }
      const detail = res.data;
      if (!editorResponseGuard.isCurrent(requestRevision)) {
        setError(
          "The workflow changed while the definition was loading. Switch again to discard the newer edits.",
        );
        return;
      }
      applyAuthoritativeDetail(detail);
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
      const res = await apiClient.workflowDefinitions.patch(id, body);
      if (!res.ok) {
        setRowError({ id, message: res.errorMessage });
        return;
      }
      const meta = res.data;
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
      const res = await apiClient.workflowDefinitions.delete(id);
      if (!res.ok) {
        setRowError({ id, message: res.errorMessage });
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
      const res = await apiClient.workflowDefinitions.create({ name, source });
      if (!res.ok) {
        setCreateError(res.errorMessage);
        return;
      }
      const detail = res.data;
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
  const repositoryScopeSummary = describeRepositoryScope(repositoryScope);

  const triggerLabel = (type: WorkflowDefinitionMeta["triggerTypes"][number]) =>
    options.blockRegistry[type]?.presentation.label ?? type;
  const deployedIsRetiredSchema = deployed !== null && deployed.schema !== "v2";

  return (
    <HarnessProfileCatalogProvider>
    <RepositoryCatalogProvider>
    <PromptLibraryProvider>
    <div className="flex flex-col h-full min-h-0">
      {deployedIsRetiredSchema ? (
        <div className="px-6 py-2 border-b border-neutral-200 bg-amber-50 font-body text-[12px] text-amber-900">
          {RETIRED_DEPLOYED_NOTE}
        </div>
      ) : deployed === null ? (
        <div className="px-6 py-2 border-b border-neutral-200 bg-app-bg font-body text-[12px] text-neutral-600">
          No deployed version selected. Save a draft, then deploy it when it is ready.
        </div>
      ) : null}
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
          key={`${selectedId}:${editorGeneration}`}
          definitionId={selectedId}
          nodes={nodes}
          edges={edges}
          limits={budgets}
          repositoryScope={repositoryScope}
          edgeGeometry={edgeGeometry}
          onLimitsChange={changeBudgets}
          onRepositoryScopeChange={changeRepositoryScope}
          onNodesChange={changeNodes}
          onNodePositionsChange={changeNodePositions}
          onEdgesChange={changeEdges}
          onEdgeGeometryChange={changeEdgeGeometry}
          onGraphChange={changeGraph}
          canUndo={editorHistoryCanUndo(editorHistory)}
          canRedo={editorHistoryCanRedo(editorHistory)}
          onUndo={undoEditor}
          onRedo={redoEditor}
          onBeginTransaction={beginEditorTransaction}
          onCommitTransaction={commitEditorTransaction}
          onCancelTransaction={cancelEditorTransaction}
          canEdit={canEdit}
          runnableTriggerIds={runnableTriggerIds}
          onRunTrigger={setManualDispatchTrigger}
          dirty={dirty}
          saveEnabled={canSave}
          saveIssues={saveIssues}
          saving={busy === "save"}
          error={error}
          validation={
            validationIsCurrent
              ? validation.state
              : {
                  status: "idle",
                  issues: [],
                  nodeContracts: {},
                  availableValuesByNode: {},
                }
          }
          dataCatalog={dataCatalog.response}
          dataCatalogRefreshing={dataCatalog.refreshing}
          dataCatalogError={dataCatalog.error}
          onSave={save}
          saveLabel="Save draft"
          headerTitle={selectedMeta?.name ?? "Workflow"}
          headerVersionBadge={deployed ? `deployed v${deployed.version}` : "not deployed"}
          headerInlineExtra={
            <>
              {showDraftDiffersFromDeployed && (
                <span
                  title="The saved draft no longer matches the deployed version. Use Reset to deployed to load what is live into the canvas."
                  className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-amber-800"
                >
                  Draft differs from deployed
                </span>
              )}
              {repositoryScopeSummary !== null && (
                <span
                  title="Repositories pinned to this workflow. Every ticket entering it inherits them."
                  className="rounded-full border border-neutral-300 bg-panel px-2 py-0.5 font-mono text-[10px] font-semibold tracking-[0.04em] text-neutral-700"
                >
                  {repositoryScopeSummary}
                </span>
              )}
              {deployedIsRetiredSchema && (
                <span
                  title={RETIRED_DEPLOYED_NOTE}
                  className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-amber-800"
                >
                  Deployed version is schema v1
                </span>
              )}
            </>
          }
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
              {canEdit && deployed !== null && (
                <button
                  onClick={resetToDeployed}
                  disabled={!canResetToDeployed || busy !== null}
                  title="Load the deployed version's nodes and edges into the canvas."
                  className={headerButtonClass}
                >
                  Reset to deployed
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
          selectionRequest={selectionRequest}
          onSelectionChange={handleSelectionChange}
        />
        {manualDispatchTrigger && deployed && (
          <ManualDispatchModal
            definitionId={selectedId}
            workflowName={selectedMeta?.name ?? "Workflow"}
            deployedVersion={deployed.version}
            trigger={manualDispatchTrigger}
            options={options}
            actorLabel={actorLabel}
            dirty={dirty}
            onClose={() => setManualDispatchTrigger(null)}
          />
        )}
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
                      {m.deployedSchema === "legacy-v1" ? (
                        <span
                          title={m.retiredMessage}
                          className="rounded-[3px] border border-amber-200 bg-amber-50 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.04em] text-amber-800"
                        >
                          Retired schema
                        </span>
                      ) : m.triggerTypes.length === 0 ? (
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
                  {m.deployedSchema === "legacy-v1" ? (
                    <span className="shrink-0 text-right font-mono text-[9px] uppercase tracking-[0.04em] text-neutral-500">
                      Stored enabled: {m.enabled ? "yes" : "no"}
                    </span>
                  ) : canEdit ? (
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
          <div className="absolute right-4 top-[56px] z-[60] w-[720px] max-w-[calc(100vw-2rem)] bg-panel border border-neutral-200 rounded-[4px] shadow-[0_12px_28px_-8px_rgba(24,27,32,0.22),0_2px_6px_rgba(24,27,32,0.08)] px-4 py-3">
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
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-neutral-100 py-2 font-body text-[12px] text-neutral-700"
              >
                <span className="shrink-0 font-mono text-neutral-900">v{v.version}</span>
                <span
                  title={
                    v.schema === "v2"
                      ? "Workflow definition schema v2"
                      : RETIRED_SCHEMA_MESSAGE
                  }
                  className={`shrink-0 rounded-[3px] border px-[6px] py-[2px] font-mono text-[9px] uppercase tracking-[0.04em] ${
                    v.schema === "v2"
                      ? "border-mariner-200 bg-mariner-100 text-mariner"
                      : "border-amber-200 bg-amber-50 text-amber-800"
                  }`}
                >
                  {v.schema === "v2" ? "schema v2" : "schema v1 · read only"}
                </span>
                {v.version === deployed?.version && (
                  <span
                    className="group relative shrink-0"
                    tabIndex={0}
                    aria-label="Currently deployed version"
                    aria-describedby={`history-version-${v.version}-deployed-tooltip`}
                  >
                    <CircleIcon
                      aria-hidden="true"
                      weight="fill"
                      className="size-2.5 text-emerald-500"
                    />
                    <span
                      id={`history-version-${v.version}-deployed-tooltip`}
                      role="tooltip"
                      className="pointer-events-none absolute left-1/2 top-full z-10 mt-2 -translate-x-1/2 whitespace-nowrap rounded-[3px] bg-neutral-900 px-2 py-1 font-body text-[10px] text-white opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus:opacity-100"
                    >
                      Currently deployed version
                    </span>
                  </span>
                )}
                <span className="min-w-0 flex-1 basis-[170px] truncate">{v.createdByLabel}</span>
                <span className="shrink-0 text-neutral-400">
                  {new Date(v.createdAt).toLocaleString()}
                </span>
                {v.restoredFromVersion !== null && (
                  <span className="shrink-0 rounded-[3px] bg-app-bg px-[6px] py-[2px] font-mono text-[10px] text-neutral-600">
                    restored from v{v.restoredFromVersion}
                  </span>
                )}
                {v.schema !== "v2" && (
                  <div className="basis-full pl-7">
                    <button
                      type="button"
                      aria-expanded={expandedLegacyVersions.has(
                        legacyVersionDisclosureKey(selectedId, v.version),
                      )}
                      aria-controls={`legacy-version-${selectedId}-${v.version}-json`}
                      onClick={() =>
                        setExpandedLegacyVersions((previous) => {
                          const disclosureKey = legacyVersionDisclosureKey(
                            selectedId,
                            v.version,
                          );
                          const next = new Set(previous);
                          if (next.has(disclosureKey)) next.delete(disclosureKey);
                          else next.add(disclosureKey);
                          return next;
                        })
                      }
                      className="appearance-none border-none bg-transparent p-0 font-body text-[12px] text-mariner cursor-pointer"
                    >
                      {legacyVersionToggleLabel(
                        expandedLegacyVersions.has(
                          legacyVersionDisclosureKey(selectedId, v.version),
                        ),
                      )}
                    </button>
                    {expandedLegacyVersions.has(
                      legacyVersionDisclosureKey(selectedId, v.version),
                    ) && (
                      <pre
                        id={`legacy-version-${selectedId}-${v.version}-json`}
                        className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-[3px] bg-app-bg p-3 font-mono text-[10px] text-neutral-700"
                      >
                        {prettyStoredWorkflowDefinition(v.definition)}
                      </pre>
                    )}
                  </div>
                )}
                {canEdit && v.schema === "v2" && v.version !== deployed?.version && (
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
    </RepositoryCatalogProvider>
    </HarnessProfileCatalogProvider>
  );
}
