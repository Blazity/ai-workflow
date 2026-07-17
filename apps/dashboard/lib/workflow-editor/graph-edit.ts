import { isTriggerBlockType } from "@shared/contracts";
import type { FlowEdgeDef, FlowNodeDef } from "@/lib/flows";

export function removeNodeFromGraph(
  nodes: FlowNodeDef[],
  edges: FlowEdgeDef[],
  nodeId: string,
): { nodes: FlowNodeDef[]; edges: FlowEdgeDef[]; removed: boolean } {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return { nodes, edges, removed: false };
  const onlyTrigger =
    isTriggerBlockType(node.type) &&
    nodes.filter((candidate) => isTriggerBlockType(candidate.type)).length === 1;
  if (onlyTrigger) {
    return { nodes, edges, removed: false };
  }
  return {
    nodes: nodes.filter((candidate) => candidate.id !== nodeId),
    edges: edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
    removed: true,
  };
}
