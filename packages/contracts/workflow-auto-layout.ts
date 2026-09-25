/**
 * Positions for a graph that carries none.
 *
 * A definition authored in the editor stores a position per node. One written
 * through the API or MCP often does not: every node arrives at 0,0, and every
 * screen that draws it stacks the whole workflow in one pile at the top left.
 * The pile is not only unreadable, it swallows the clicks: only the node drawn
 * last is on top, so selecting a block always selects that one.
 *
 * So a drawing surface asks here instead of trusting the stored numbers, and
 * the worker asks the same question before it stores the positions a caller
 * sent: one rule for "these positions say nothing", read by every side. This
 * module is pure and deterministic: the same graph lays out the same way every
 * time, which matters because a replay is read alongside a run and must not
 * shuffle between two people looking at it.
 */
import type { WorkflowLayoutPoint } from "./domain";


/** Nodes in the order the definition lists them, which is the order used to
 *  break ties inside a layer. */
export interface AutoLayoutNode {
  id: string;
  x: number;
  y: number;
}

export interface AutoLayoutEdge {
  from: string;
  to: string;
}

/**
 * Whether the stored positions say anything at all.
 *
 * True when every node sits on the same point, which is what "nobody ever
 * placed these" looks like in the data. One node cannot be a pile, so a
 * single-node graph keeps whatever it has.
 */
export function positionsCarryNoLayout(nodes: readonly AutoLayoutNode[]): boolean {
  if (nodes.length < 2) return false;
  const first = nodes[0]!;
  return nodes.every((node) => node.x === first.x && node.y === first.y);
}

/**
 * A left to right layered layout: every node sits one column right of the
 * furthest node that reaches it, and nodes that share a column stack downwards.
 *
 * Longest path rather than shortest, so an edge never points backwards: a node
 * fed by both the trigger and a later block is drawn after the later one. A
 * cycle cannot be layered this way, and a loop in a definition is legal, so
 * whatever a pass cannot resolve is laid out after everything that could be, in
 * its own columns. That keeps the drawing readable instead of failing.
 */
export function autoLayoutPositions(
  nodes: readonly AutoLayoutNode[],
  edges: readonly AutoLayoutEdge[],
  step: WorkflowLayoutPoint,
): Map<string, WorkflowLayoutPoint> {
  const ids = new Set(nodes.map((node) => node.id));
  const incoming = new Map<string, string[]>();
  for (const node of nodes) incoming.set(node.id, []);
  for (const edge of edges) {
    // An edge naming a node the graph does not hold is not ours to fix; it
    // simply cannot constrain a position.
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
    incoming.get(edge.to)!.push(edge.from);
  }

  const depth = new Map<string, number>();
  // Repeated passes rather than a topological sort: the graph is small (a
  // definition is tens of nodes at most) and this needs no cycle detection of
  // its own. It stops as soon as a pass settles nothing new.
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;
    for (const node of nodes) {
      const parents = incoming.get(node.id)!;
      const known = parents.map((id) => depth.get(id)).filter((value): value is number => value !== undefined);
      const next = parents.length === 0 ? 0 : known.length === parents.length ? Math.max(...known) + 1 : undefined;
      if (next !== undefined && depth.get(node.id) !== next) {
        depth.set(node.id, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Everything a cycle left unresolved goes to the right of the rest, in the
  // order the definition lists it, so it is visible rather than piled at 0,0.
  const settled = [...depth.values()];
  let unresolvedColumn = settled.length === 0 ? 0 : Math.max(...settled) + 1;
  for (const node of nodes) {
    if (!depth.has(node.id)) {
      depth.set(node.id, unresolvedColumn);
      unresolvedColumn += 1;
    }
  }

  const rowsInColumn = new Map<number, number>();
  const positions = new Map<string, WorkflowLayoutPoint>();
  for (const node of nodes) {
    const column = depth.get(node.id)!;
    const row = rowsInColumn.get(column) ?? 0;
    rowsInColumn.set(column, row + 1);
    positions.set(node.id, { x: column * step.x, y: row * step.y });
  }
  return positions;
}
