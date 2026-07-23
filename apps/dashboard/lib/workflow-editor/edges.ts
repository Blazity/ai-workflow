import { BLOCK_TYPE_SPECS, DEFAULT_OUT_PORT, FAILURE_PORT } from "@shared/contracts";
import type { WorkflowBlockType } from "@shared/contracts";
import type { FlowEdgeDef } from "@/lib/flows";

export function defaultPort(type: WorkflowBlockType): string {
  return BLOCK_TYPE_SPECS[type].ports[0] ?? DEFAULT_OUT_PORT;
}

export function canOmitFromPort(type: WorkflowBlockType, port: string): boolean {
  const ports = BLOCK_TYPE_SPECS[type].ports;
  return ports.length === 1 && port === ports[0];
}

export function resolvedPort(edge: FlowEdgeDef, sourceType: WorkflowBlockType): string {
  return edge.fromPort ?? defaultPort(sourceType);
}

export function edgeKey(edge: FlowEdgeDef): string {
  return JSON.stringify([edge.from, edge.fromPort ?? null, edge.to]);
}

export function edgeInstanceKey(edges: readonly FlowEdgeDef[], index: number): string {
  const edge = edges[index];
  if (!edge) return "";
  if (edge.id) return edge.id;
  const key = edgeKey(edge);
  let occurrence = 0;
  for (let i = 0; i < index; i++) {
    if (edgeKey(edges[i]) === key) occurrence++;
  }
  return JSON.stringify([key, occurrence]);
}

export type EdgeKeyboardAction = "select" | "delete";

export function edgeKeyboardAction(
  key: string,
  canEdit: boolean,
): EdgeKeyboardAction | null {
  if (key === "Enter" || key === " ") return "select";
  if (canEdit && (key === "Delete" || key === "Backspace")) return "delete";
  return null;
}

export function edgeDeleteActionVisible({
  canEdit,
  hovered,
  selected,
}: {
  canEdit: boolean;
  hovered: boolean;
  selected: boolean;
}): boolean {
  return canEdit && (hovered || selected);
}

export function edgeDeleteTargetRadius(zoom: number): number {
  return 22 / zoom;
}

export function reconcileSelectedEdgeKey(
  selectedEdgeKey: string | null,
  edges: readonly FlowEdgeDef[],
  selectedNodeId: string | null,
): string | null {
  if (!selectedEdgeKey || selectedNodeId) return null;
  return edges.some((_, index) => edgeInstanceKey(edges, index) === selectedEdgeKey)
    ? selectedEdgeKey
    : null;
}

export function removeEdge(
  edges: readonly FlowEdgeDef[],
  instanceKey: string,
): FlowEdgeDef[] {
  return edges.filter((_, index) => edgeInstanceKey(edges, index) !== instanceKey);
}

export function visibleOutPorts(
  type: WorkflowBlockType,
  failureUsed: boolean,
  reveal: boolean,
  schemaVersion: 1 | 2 = 1,
): string[] {
  const spec = BLOCK_TYPE_SPECS[type];
  const ports = [...spec.ports];
  if (
    schemaVersion === 1 &&
    spec.allowsFailurePort &&
    (failureUsed || reveal)
  ) {
    ports.push(FAILURE_PORT);
  }
  return ports;
}

export type UpsertEdgeOptions =
  | { schemaVersion?: 1 }
  | ({
      schemaVersion: 2;
    } & (
      | { edgeId: string; generateEdgeId?: never }
      | { edgeId?: never; generateEdgeId: () => string }
    ));

function requireUsableEdgeId(id: string, usedIds: ReadonlySet<string>): string {
  if (id.length === 0 || id.trim() !== id) {
    throw new Error("V2 edge id must be a non-empty, unpadded string.");
  }
  if (usedIds.has(id)) {
    throw new Error(`V2 edge id "${id}" is already in use.`);
  }
  return id;
}

function allocateV2EdgeId(
  edges: readonly FlowEdgeDef[],
  options: Extract<UpsertEdgeOptions, { schemaVersion: 2 }>,
): string {
  const usedIds = new Set(
    edges.flatMap((edge) => (edge.id === undefined ? [] : [edge.id])),
  );
  if (options.edgeId !== undefined) {
    return requireUsableEdgeId(options.edgeId, usedIds);
  }
  if (typeof options.generateEdgeId !== "function") {
    throw new Error("V2 edge creation requires an edge id or id generator.");
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = options.generateEdgeId();
    if (
      candidate.length > 0 &&
      candidate.trim() === candidate &&
      !usedIds.has(candidate)
    ) {
      return candidate;
    }
  }
  throw new Error("Could not generate a unique v2 edge id.");
}

export function upsertEdge(
  edges: readonly FlowEdgeDef[],
  from: string,
  port: string,
  to: string,
  sourceType: WorkflowBlockType,
  options: UpsertEdgeOptions = {},
): FlowEdgeDef[] {
  if (from === to) return [...edges];
  const occupies = (e: FlowEdgeDef) => e.from === from && resolvedPort(e, sourceType) === port;
  if (options.schemaVersion === 2) {
    const isExactConnection = (edge: FlowEdgeDef) =>
      occupies(edge) && edge.to === to;
    const firstExact = edges.findIndex(isExactConnection);
    if (firstExact !== -1) {
      return edges.filter(
        (edge, index) => index === firstExact || !isExactConnection(edge),
      );
    }
    const next: FlowEdgeDef = {
      id: allocateV2EdgeId(edges, options),
      from,
      to,
      ...(canOmitFromPort(sourceType, port) ? {} : { fromPort: port }),
    };
    return [...edges, next];
  }

  const next: FlowEdgeDef = canOmitFromPort(sourceType, port)
    ? { from, to }
    : { from, to, fromPort: port };
  const idx = edges.findIndex(occupies);
  if (idx === -1) return [...edges, next];
  // Replace in place. Re-dragging a connection to the same target must not reorder
  // the array, or the JSON dirty check flips on a semantically identical graph.
  return edges.filter((e, i) => i === idx || !occupies(e)).map((e, i) => (i === idx ? next : e));
}

export function isBackEdge(edges: readonly FlowEdgeDef[], edge: FlowEdgeDef): boolean {
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.from);
    if (list) list.push(e.to);
    else adjacency.set(e.from, [e.to]);
  }
  const stack = [edge.to];
  const seen = new Set<string>();
  while (stack.length) {
    const node = stack.pop() as string;
    if (node === edge.from) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of adjacency.get(node) ?? []) stack.push(next);
  }
  return false;
}
