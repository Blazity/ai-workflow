import type { FlowNodeDef } from "@/lib/flows";

export const NODE_W = 168;
export const NODE_H = 84;

export interface Point { x: number; y: number; }

export function portPos(node: FlowNodeDef, kind: "in" | "out"): Point {
  if (kind === "in") return { x: node.x, y: node.y + NODE_H / 2 };
  return { x: node.x + NODE_W, y: node.y + NODE_H / 2 };
}

export function bezier(p1: Point, p2: Point): string {
  const dx = Math.max(40, Math.abs(p2.x - p1.x) * 0.45);
  return `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`;
}
