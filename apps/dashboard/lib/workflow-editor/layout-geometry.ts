import type {
  WorkflowDefinitionLayout,
  WorkflowEdgeGeometry,
  WorkflowLayoutPoint,
} from "@shared/contracts";

export const DEFAULT_CANVAS_GRID_SIZE = 20;

export function automaticEdgeBendPoint(
  from: WorkflowLayoutPoint,
  to: WorkflowLayoutPoint,
): WorkflowLayoutPoint {
  return {
    x: (from.x + to.x) / 2,
    y: (from.y + to.y) / 2,
  };
}

/** Build a smooth path that passes through an authored bend when one exists. */
export function edgeBezierPath(
  from: WorkflowLayoutPoint,
  to: WorkflowLayoutPoint,
  geometry?: WorkflowEdgeGeometry,
): string {
  if (!geometry) {
    const dx = Math.max(40, Math.abs(to.x - from.x) * 0.45);
    return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
  }

  const bend = geometry.bend;
  const firstDirection = bend.x >= from.x ? 1 : -1;
  const secondDirection = to.x >= bend.x ? 1 : -1;
  const joinDirection = to.x >= from.x ? 1 : -1;
  const firstDx = Math.max(20, Math.abs(bend.x - from.x) * 0.45);
  const secondDx = Math.max(20, Math.abs(to.x - bend.x) * 0.45);
  return [
    `M ${from.x} ${from.y}`,
    `C ${from.x + firstDirection * firstDx} ${from.y},`,
    `${bend.x - joinDirection * firstDx} ${bend.y},`,
    `${bend.x} ${bend.y}`,
    `C ${bend.x + joinDirection * secondDx} ${bend.y},`,
    `${to.x - secondDirection * secondDx} ${to.y},`,
    `${to.x} ${to.y}`,
  ].join(" ");
}

export function nudgeEdgeGeometry(
  geometry: WorkflowEdgeGeometry | undefined,
  delta: WorkflowLayoutPoint,
  automaticBend: WorkflowLayoutPoint,
): WorkflowEdgeGeometry {
  const bend = geometry?.bend ?? automaticBend;
  return {
    bend: {
      x: bend.x + delta.x,
      y: bend.y + delta.y,
    },
  };
}

export function offsetEdgeGeometry(
  geometry: WorkflowEdgeGeometry,
  delta: WorkflowLayoutPoint,
): WorkflowEdgeGeometry {
  return {
    bend: {
      x: geometry.bend.x + delta.x,
      y: geometry.bend.y + delta.y,
    },
  };
}

export function setWorkflowEdgeBend(
  layout: WorkflowDefinitionLayout,
  edgeId: string,
  bend: WorkflowLayoutPoint,
): WorkflowDefinitionLayout {
  return {
    nodes: layout.nodes,
    edges: {
      ...layout.edges,
      [edgeId]: {
        bend: { ...bend },
      },
    },
  };
}

/** Remove authored geometry so the edge returns to automatic routing. */
export function resetWorkflowEdgeBend(
  layout: WorkflowDefinitionLayout,
  edgeId: string,
): WorkflowDefinitionLayout {
  if (!(edgeId in layout.edges)) return layout;
  const edges = { ...layout.edges };
  delete edges[edgeId];
  return { nodes: layout.nodes, edges };
}

export interface CanvasGridMetrics {
  size: number;
  offset: WorkflowLayoutPoint;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

/** Keep screen-space dots aligned to canvas coordinates during pan and zoom. */
export function canvasGridMetrics(
  pan: WorkflowLayoutPoint,
  zoom: number,
  canvasGridSize = DEFAULT_CANVAS_GRID_SIZE,
): CanvasGridMetrics {
  if (
    !Number.isFinite(zoom) ||
    zoom <= 0 ||
    !Number.isFinite(canvasGridSize) ||
    canvasGridSize <= 0
  ) {
    throw new RangeError("Canvas grid scale must be positive and finite");
  }
  const size = canvasGridSize * zoom;
  return {
    size,
    offset: {
      x: positiveModulo(pan.x, size),
      y: positiveModulo(pan.y, size),
    },
  };
}
