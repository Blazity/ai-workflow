export interface CanvasSelection {
  nodeIds: string[];
  edgeKeys: string[];
  primaryNodeId: string | null;
}

export const EMPTY_CANVAS_SELECTION: CanvasSelection = {
  nodeIds: [],
  edgeKeys: [],
  primaryNodeId: null,
};

function without(values: readonly string[], value: string): string[] {
  return values.filter((candidate) => candidate !== value);
}

export function selectCanvasNode(
  selection: CanvasSelection,
  nodeId: string,
  additive: boolean,
): CanvasSelection {
  if (!additive) {
    return { nodeIds: [nodeId], edgeKeys: [], primaryNodeId: nodeId };
  }
  if (selection.nodeIds.includes(nodeId)) {
    const nodeIds = without(selection.nodeIds, nodeId);
    return {
      ...selection,
      nodeIds,
      primaryNodeId:
        selection.primaryNodeId === nodeId
          ? (nodeIds.at(-1) ?? null)
          : selection.primaryNodeId,
    };
  }
  return {
    ...selection,
    nodeIds: [...selection.nodeIds, nodeId],
    primaryNodeId: nodeId,
  };
}

export function selectCanvasEdge(
  selection: CanvasSelection,
  edgeKey: string,
  additive: boolean,
): CanvasSelection {
  if (!additive) {
    return { nodeIds: [], edgeKeys: [edgeKey], primaryNodeId: null };
  }
  return {
    ...selection,
    edgeKeys: selection.edgeKeys.includes(edgeKey)
      ? without(selection.edgeKeys, edgeKey)
      : [...selection.edgeKeys, edgeKey],
  };
}

export function reconcileCanvasSelection(
  selection: CanvasSelection,
  nodeIds: ReadonlySet<string>,
  edgeKeys: ReadonlySet<string>,
): CanvasSelection {
  const nextNodeIds = selection.nodeIds.filter((id) => nodeIds.has(id));
  const nextEdgeKeys = selection.edgeKeys.filter((key) => edgeKeys.has(key));
  const primaryNodeId =
    selection.primaryNodeId && nextNodeIds.includes(selection.primaryNodeId)
      ? selection.primaryNodeId
      : (nextNodeIds.at(-1) ?? null);
  if (
    primaryNodeId === selection.primaryNodeId &&
    nextNodeIds.length === selection.nodeIds.length &&
    nextEdgeKeys.length === selection.edgeKeys.length
  ) {
    return selection;
  }
  return {
    nodeIds: nextNodeIds,
    edgeKeys: nextEdgeKeys,
    primaryNodeId,
  };
}

export function dragSelectionNodeIds(
  selection: CanvasSelection,
  pressedNodeId: string,
): string[] {
  return selection.nodeIds.includes(pressedNodeId)
    ? selection.nodeIds
    : [pressedNodeId];
}

export function isAdditiveCanvasSelection(
  event: Pick<MouseEvent, "shiftKey" | "metaKey" | "ctrlKey">,
): boolean {
  return event.shiftKey || event.metaKey || event.ctrlKey;
}
