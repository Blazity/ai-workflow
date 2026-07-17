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
  return `${edge.from}|${edge.fromPort ?? ""}|${edge.to}`;
}

export function visibleOutPorts(
  type: WorkflowBlockType,
  failureUsed: boolean,
  reveal: boolean,
): string[] {
  const spec = BLOCK_TYPE_SPECS[type];
  const ports = [...spec.ports];
  if (spec.allowsFailurePort && (failureUsed || reveal)) ports.push(FAILURE_PORT);
  return ports;
}

export function upsertEdge(
  edges: readonly FlowEdgeDef[],
  from: string,
  port: string,
  to: string,
  sourceType: WorkflowBlockType,
): FlowEdgeDef[] {
  if (from === to) return [...edges];
  const next: FlowEdgeDef = canOmitFromPort(sourceType, port) ? { from, to } : { from, to, fromPort: port };
  const occupies = (e: FlowEdgeDef) => e.from === from && resolvedPort(e, sourceType) === port;
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
