import { isTriggerBlockType } from "@shared/contracts";
import type { FlowEdgeDef, FlowNodeDef } from "@/lib/flows";
import { edgeInstanceKey } from "./edges";

export type GraphSelectionDeleteBlocker = "trigger_required";

export interface GraphSelectionDeleteResult {
  nodes: FlowNodeDef[];
  edges: FlowEdgeDef[];
  removed: boolean;
  blocker: GraphSelectionDeleteBlocker | null;
}

export function removeSelectionFromGraph(
  nodes: FlowNodeDef[],
  edges: FlowEdgeDef[],
  selection: {
    nodeIds: Iterable<string>;
    edgeKeys: Iterable<string>;
  },
): GraphSelectionDeleteResult {
  const requestedNodeIds = new Set(selection.nodeIds);
  const selectedNodeIds = new Set(
    nodes
      .filter((node) => requestedNodeIds.has(node.id))
      .map((node) => node.id),
  );
  const selectedEdgeKeys = new Set(selection.edgeKeys);
  const selectedEdgeIndexes = new Set<number>();
  for (const [index] of edges.entries()) {
    if (selectedEdgeKeys.has(edgeInstanceKey(edges, index))) {
      selectedEdgeIndexes.add(index);
    }
  }

  const triggerCount = nodes.filter((node) =>
    isTriggerBlockType(node.type),
  ).length;
  const selectedTriggerCount = nodes.filter(
    (node) =>
      selectedNodeIds.has(node.id) && isTriggerBlockType(node.type),
  ).length;
  if (
    selectedTriggerCount > 0 &&
    triggerCount - selectedTriggerCount < 1
  ) {
    return {
      nodes,
      edges,
      removed: false,
      blocker: "trigger_required",
    };
  }

  if (selectedNodeIds.size === 0 && selectedEdgeIndexes.size === 0) {
    return { nodes, edges, removed: false, blocker: null };
  }

  return {
    nodes: nodes.filter((node) => !selectedNodeIds.has(node.id)),
    edges: edges.filter(
      (edge, index) =>
        !selectedEdgeIndexes.has(index) &&
        !selectedNodeIds.has(edge.from) &&
        !selectedNodeIds.has(edge.to),
    ),
    removed: true,
    blocker: null,
  };
}

export function removeNodeFromGraph(
  nodes: FlowNodeDef[],
  edges: FlowEdgeDef[],
  nodeId: string,
): { nodes: FlowNodeDef[]; edges: FlowEdgeDef[]; removed: boolean } {
  const result = removeSelectionFromGraph(nodes, edges, {
    nodeIds: [nodeId],
    edgeKeys: [],
  });
  return {
    nodes: result.nodes,
    edges: result.edges,
    removed: result.removed,
  };
}
