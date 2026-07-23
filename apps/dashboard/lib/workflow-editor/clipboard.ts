import {
  isWorkflowAddressablePathSegment,
  type JsonValue,
  type WorkflowDefinitionValidationIssue,
} from "@shared/contracts";
import type { FlowEdgeDef, FlowNodeDef } from "@/lib/flows";
import { edgeInstanceKey } from "./edges";
import {
  collectFlowNodeReferences,
  remapFlowNodeReferences,
  workflowReferenceSourceNodeId,
} from "./reference-visitor";

export const WORKFLOW_SESSION_CLIPBOARD_KEY =
  "ai-workflow.workflow-editor.clipboard.v1";

export interface WorkflowClipboardEdge<TGeometry = JsonValue> {
  edge: FlowEdgeDef;
  geometry?: TGeometry;
}

export interface WorkflowClipboardPayload<TGeometry = JsonValue> {
  version: 1;
  schemaVersion: 1 | 2;
  nodes: FlowNodeDef[];
  edges: WorkflowClipboardEdge<TGeometry>[];
  pasteCount: number;
}

export interface WorkflowClipboardPasteSuccess<TGeometry = JsonValue> {
  ok: true;
  nodes: FlowNodeDef[];
  edges: FlowEdgeDef[];
  edgeGeometry: Record<string, TGeometry>;
  addedNodes: FlowNodeDef[];
  addedEdges: FlowEdgeDef[];
  selectedNodeIds: string[];
  selectedEdgeKeys: string[];
  nodeIdMap: Map<string, string>;
  issues: WorkflowDefinitionValidationIssue[];
  nextClipboard: WorkflowClipboardPayload<TGeometry>;
}

export type WorkflowClipboardPasteResult<TGeometry = JsonValue> =
  | WorkflowClipboardPasteSuccess<TGeometry>
  | {
      ok: false;
      reason: "schema_version_mismatch" | "empty";
    };

export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createWorkflowClipboardPayload<TGeometry = JsonValue>(input: {
  schemaVersion: 1 | 2;
  nodes: readonly FlowNodeDef[];
  edges: readonly FlowEdgeDef[];
  selectedNodeIds: Iterable<string>;
  edgeGeometry?: Readonly<Record<string, TGeometry>>;
}): WorkflowClipboardPayload<TGeometry> | null {
  const requested = new Set(input.selectedNodeIds);
  const nodes = input.nodes.filter((node) => requested.has(node.id));
  if (nodes.length === 0) return null;
  const selected = new Set(nodes.map((node) => node.id));
  const edges: WorkflowClipboardEdge<TGeometry>[] = [];
  for (const [index, edge] of input.edges.entries()) {
    if (!selected.has(edge.from) || !selected.has(edge.to)) continue;
    const key = edgeInstanceKey(input.edges, index);
    const geometry = input.edgeGeometry?.[key];
    edges.push({
      edge: clone(edge),
      ...(geometry === undefined ? {} : { geometry: clone(geometry) }),
    });
  }
  return {
    version: 1,
    schemaVersion: input.schemaVersion,
    nodes: clone(nodes),
    edges,
    pasteCount: 0,
  };
}

function isClipboardPayload(value: unknown): value is WorkflowClipboardPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    (record.schemaVersion !== 1 && record.schemaVersion !== 2) ||
    !Array.isArray(record.nodes) ||
    record.nodes.length === 0 ||
    !Array.isArray(record.edges) ||
    !Number.isInteger(record.pasteCount) ||
    (record.pasteCount as number) < 0
  ) {
    return false;
  }
  const nodeIds = new Set<string>();
  const nodesValid = record.nodes.every((node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return false;
    const candidate = node as Record<string, unknown>;
    if (
      typeof candidate.id !== "string" ||
      candidate.id.length === 0 ||
      nodeIds.has(candidate.id) ||
      typeof candidate.type !== "string" ||
      typeof candidate.x !== "number" ||
      !Number.isFinite(candidate.x) ||
      typeof candidate.y !== "number" ||
      !Number.isFinite(candidate.y) ||
      !candidate.params ||
      typeof candidate.params !== "object" ||
      Array.isArray(candidate.params) ||
      !candidate.inputs ||
      typeof candidate.inputs !== "object" ||
      Array.isArray(candidate.inputs)
    ) {
      return false;
    }
    nodeIds.add(candidate.id);
    return true;
  });
  const edgesValid = record.edges.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const edge = (entry as Record<string, unknown>).edge;
    return (
      edge &&
      typeof edge === "object" &&
      typeof (edge as Record<string, unknown>).from === "string" &&
      nodeIds.has((edge as Record<string, unknown>).from as string) &&
      typeof (edge as Record<string, unknown>).to === "string" &&
      nodeIds.has((edge as Record<string, unknown>).to as string)
    );
  });
  return nodesValid && edgesValid;
}

export function readSessionWorkflowClipboard<TGeometry = JsonValue>(
  storage: SessionStorageLike,
  key = WORKFLOW_SESSION_CLIPBOARD_KEY,
): WorkflowClipboardPayload<TGeometry> | null {
  try {
    const serialized = storage.getItem(key);
    if (serialized === null) return null;
    const parsed = JSON.parse(serialized) as unknown;
    return isClipboardPayload(parsed)
      ? (parsed as WorkflowClipboardPayload<TGeometry>)
      : null;
  } catch {
    return null;
  }
}

export function writeSessionWorkflowClipboard<TGeometry = JsonValue>(
  storage: SessionStorageLike,
  payload: WorkflowClipboardPayload<TGeometry>,
  key = WORKFLOW_SESSION_CLIPBOARD_KEY,
): boolean {
  try {
    storage.setItem(key, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function clearSessionWorkflowClipboard(
  storage: SessionStorageLike,
  key = WORKFLOW_SESSION_CLIPBOARD_KEY,
): void {
  try {
    storage.removeItem(key);
  } catch {
    // Storage may be blocked or unavailable. The in-memory editor remains usable.
  }
}

function copyIdBase(sourceId: string, index: number): string {
  const direct = `${sourceId}-copy`;
  if (
    sourceId !== "entry" &&
    isWorkflowAddressablePathSegment(direct)
  ) {
    return direct;
  }
  const sanitized = sourceId
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const candidate = `copy-${sanitized || index + 1}`;
  return isWorkflowAddressablePathSegment(candidate)
    ? candidate
    : `copy-${index + 1}`;
}

function allocateNodeId(
  sourceId: string,
  index: number,
  unavailable: Set<string>,
): string {
  const base = copyIdBase(sourceId, index);
  for (let suffix = 1; suffix <= 10_000; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    if (candidate !== "entry" && !unavailable.has(candidate)) {
      unavailable.add(candidate);
      return candidate;
    }
  }
  throw new Error(`Unable to allocate a node id for "${sourceId}".`);
}

function defaultGenerateEdgeId(): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("V2 clipboard paste requires an edge id generator.");
  }
  return globalThis.crypto.randomUUID();
}

function allocateEdgeId(
  unavailable: Set<string>,
  generateEdgeId: () => string,
): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = generateEdgeId();
    if (
      candidate.length > 0 &&
      candidate.trim() === candidate &&
      !unavailable.has(candidate)
    ) {
      unavailable.add(candidate);
      return candidate;
    }
  }
  throw new Error("Unable to allocate a fresh edge id for pasted connections.");
}

function unavailableExternalSourceIds(
  payload: WorkflowClipboardPayload<unknown>,
  destinationNodeIds: ReadonlySet<string>,
): Set<string> {
  const internal = new Set(payload.nodes.map((node) => node.id));
  const reserved = new Set<string>();
  for (const node of payload.nodes) {
    for (const occurrence of collectFlowNodeReferences(node)) {
      const sourceId = workflowReferenceSourceNodeId(occurrence.reference);
      if (
        sourceId &&
        !internal.has(sourceId) &&
        !destinationNodeIds.has(sourceId)
      ) {
        reserved.add(sourceId);
      }
    }
  }
  return reserved;
}

export function planWorkflowClipboardPaste<TGeometry = JsonValue>(input: {
  payload: WorkflowClipboardPayload<TGeometry>;
  schemaVersion: 1 | 2;
  destinationNodes: readonly FlowNodeDef[];
  destinationEdges: readonly FlowEdgeDef[];
  destinationEdgeGeometry?: Readonly<Record<string, TGeometry>>;
  generateEdgeId?: () => string;
  offsetEdgeGeometry?: (
    geometry: TGeometry,
    delta: { x: number; y: number },
  ) => TGeometry;
}): WorkflowClipboardPasteResult<TGeometry> {
  if (input.payload.schemaVersion !== input.schemaVersion) {
    return { ok: false, reason: "schema_version_mismatch" };
  }
  if (input.payload.nodes.length === 0) {
    return { ok: false, reason: "empty" };
  }

  const destinationNodeIds = new Set(
    input.destinationNodes.map((node) => node.id),
  );
  const unavailableNodeIds = new Set(destinationNodeIds);
  unavailableNodeIds.add("entry");
  for (const sourceId of unavailableExternalSourceIds(
    input.payload,
    destinationNodeIds,
  )) {
    unavailableNodeIds.add(sourceId);
  }
  const nodeIdMap = new Map<string, string>();
  input.payload.nodes.forEach((node, index) => {
    nodeIdMap.set(
      node.id,
      allocateNodeId(node.id, index, unavailableNodeIds),
    );
  });

  const offset = 32 * (input.payload.pasteCount + 1);
  const addedNodes = input.payload.nodes.map((node) => {
    const remapped = remapFlowNodeReferences(node, nodeIdMap);
    return {
      ...remapped,
      id: nodeIdMap.get(node.id)!,
      x: node.x + offset,
      y: node.y + offset,
    };
  });

  const unavailableEdgeIds = new Set(
    input.destinationEdges.flatMap((edge) =>
      edge.id === undefined ? [] : [edge.id],
    ),
  );
  const generateEdgeId = input.generateEdgeId ?? defaultGenerateEdgeId;
  const addedEdges = input.payload.edges.map(({ edge }) => ({
    ...(input.schemaVersion === 2
      ? {
          id: allocateEdgeId(unavailableEdgeIds, generateEdgeId),
        }
      : {}),
    from: nodeIdMap.get(edge.from)!,
    to: nodeIdMap.get(edge.to)!,
    ...(edge.fromPort === undefined ? {} : { fromPort: edge.fromPort }),
  }));
  const nodes = [...input.destinationNodes, ...addedNodes];
  const edges = [...input.destinationEdges, ...addedEdges];
  const edgeGeometry: Record<string, TGeometry> = {
    ...(input.destinationEdgeGeometry
      ? clone(input.destinationEdgeGeometry)
      : {}),
  };
  const selectedEdgeKeys: string[] = [];
  input.payload.edges.forEach((clipboardEdge, index) => {
    const destinationIndex = input.destinationEdges.length + index;
    const key = edgeInstanceKey(edges, destinationIndex);
    selectedEdgeKeys.push(key);
    if (clipboardEdge.geometry === undefined) return;
    edgeGeometry[key] = input.offsetEdgeGeometry
      ? input.offsetEdgeGeometry(clone(clipboardEdge.geometry), {
          x: offset,
          y: offset,
        })
      : clone(clipboardEdge.geometry);
  });

  const allNodeIds = new Set(nodes.map((node) => node.id));
  const issues: WorkflowDefinitionValidationIssue[] = [];
  addedNodes.forEach((node, addedIndex) => {
    for (const occurrence of collectFlowNodeReferences(node)) {
      const sourceId = workflowReferenceSourceNodeId(occurrence.reference);
      if (!sourceId || allNodeIds.has(sourceId)) continue;
      issues.push({
        code: "clipboard.reference.unavailable",
        severity: "error",
        nodeId: node.id,
        path: `/nodes/${input.destinationNodes.length + addedIndex}${occurrence.path}`,
        message: `Pasted block "${node.name || node.id}" references unavailable block "${sourceId}".`,
      });
    }
  });

  return {
    ok: true,
    nodes,
    edges,
    edgeGeometry,
    addedNodes,
    addedEdges,
    selectedNodeIds: addedNodes.map((node) => node.id),
    selectedEdgeKeys,
    nodeIdMap,
    issues,
    nextClipboard: {
      ...clone(input.payload),
      pasteCount: input.payload.pasteCount + 1,
    },
  };
}
