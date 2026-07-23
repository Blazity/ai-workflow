import type { FlowNodeDef } from "@/lib/flows";
import type { WorkflowEdgeGeometry } from "@shared/contracts";
import { edgeBezierPath } from "@/lib/workflow-editor/layout-geometry";

// Match the original editor's card footprint. The smaller PR #118 dimensions
// forced long block labels and ids to wrap inside a fixed-height card.
export const NODE_W = 190;
export const NODE_H = 94;

export interface Point { x: number; y: number; }

export function inPortPos(node: FlowNodeDef): Point {
  return { x: node.x, y: node.y + NODE_H / 2 };
}

export function outPortPos(node: FlowNodeDef, portIndex: number, portCount: number): Point {
  const count = Math.max(1, portCount);
  return { x: node.x + NODE_W, y: node.y + (NODE_H * (portIndex + 1)) / (count + 1) };
}

export function bezier(
  p1: Point,
  p2: Point,
  geometry?: WorkflowEdgeGeometry,
): string {
  return edgeBezierPath(p1, p2, geometry);
}
