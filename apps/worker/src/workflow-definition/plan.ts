import type {
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowParamValue,
} from "@shared/contracts";

export interface OrderedBlock {
  id: string;
  type: WorkflowBlockType;
  params: Record<string, WorkflowParamValue>;
}

export function orderBlocks(def: WorkflowDefinition): OrderedBlock[] {
  const nodeById = new Map(def.nodes.map((node) => [node.id, node] as const));
  const nextOf = new Map<string, string>();
  for (const edge of def.edges) {
    if (!nextOf.has(edge.from)) nextOf.set(edge.from, edge.to);
  }

  const trigger = def.nodes.find((node) => node.type === "trigger_ticket_ai");
  const result: OrderedBlock[] = [];
  if (!trigger) return result;

  const visited = new Set<string>([trigger.id]);
  let currentId = nextOf.get(trigger.id);
  while (currentId !== undefined && !visited.has(currentId)) {
    const node = nodeById.get(currentId);
    if (!node) break;
    visited.add(currentId);
    result.push({ id: node.id, type: node.type, params: node.params });
    currentId = nextOf.get(currentId);
  }

  return result;
}
