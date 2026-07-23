import { isTriggerBlockType } from "@shared/contracts";
import type { FlowNodeDef } from "@/lib/flows";

const STEP_REFERENCE = /(?:^|[^A-Za-z0-9_-])steps\.([A-Za-z_][A-Za-z0-9_-]*)\.output(?:\.|$)/g;

/**
 * Resolves only the producing nodes represented by a canonical data reference.
 * This is presentation-only and never adds a control-flow edge.
 */
export function sourceNodeIdsForReference(
  value: string,
  nodes: readonly FlowNodeDef[],
): string[] {
  const known = new Set(nodes.map((node) => node.id));
  const sources = new Set<string>();
  for (const match of value.matchAll(STEP_REFERENCE)) {
    const id = match[1];
    if (!id) continue;
    if (known.has(id)) {
      sources.add(id);
      continue;
    }
    if (id === "entry") {
      for (const node of nodes) {
        if (isTriggerBlockType(node.type)) sources.add(node.id);
      }
    }
  }
  return [...sources];
}
