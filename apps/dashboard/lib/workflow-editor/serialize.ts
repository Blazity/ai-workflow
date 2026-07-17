import { BLOCK_PARAM_KEYS } from "@shared/contracts";
import type {
  WorkflowDefinition,
  WorkflowDefinitionEdge,
  WorkflowDefinitionLayout,
  WorkflowDefinitionNode,
  WorkflowParamValue,
} from "@shared/contracts";
import type { FlowEdgeDef, FlowNodeDef } from "@/lib/flows";
import { canOmitFromPort } from "./edges";

// The canonical param-key allowlist lives in @shared/contracts (BLOCK_PARAM_KEYS).
// Import it rather than keeping a dashboard copy so the two can never drift (a
// stale copy previously stripped call_llm's `provider` on save).

function serializeParams(node: FlowNodeDef): Record<string, WorkflowParamValue> {
  const out: Record<string, WorkflowParamValue> = {};
  for (const key of BLOCK_PARAM_KEYS[node.type]) {
    const value = node.params[key];
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    out[key] = value;
  }
  return out;
}

export function serializeWorkflowDefinition(
  nodes: readonly FlowNodeDef[],
  edges: readonly FlowEdgeDef[],
): WorkflowDefinition {
  const typeById = new Map(nodes.map((node) => [node.id, node.type]));
  return {
    schemaVersion: 1,
    nodes: nodes.map((node) => {
      const serialized: WorkflowDefinitionNode = {
        id: node.id,
        type: node.type,
        x: Math.round(node.x),
        y: Math.round(node.y),
        params: serializeParams(node),
        inputs: { ...node.inputs },
      };
      if (node.name !== undefined) serialized.name = node.name;
      return serialized;
    }),
    edges: edges.map((edge) => {
      const serialized: WorkflowDefinitionEdge = { from: edge.from, to: edge.to };
      const sourceType = typeById.get(edge.from);
      if (
        edge.fromPort !== undefined &&
        !(sourceType !== undefined && canOmitFromPort(sourceType, edge.fromPort))
      ) {
        serialized.fromPort = edge.fromPort;
      }
      return serialized;
    }),
  };
}

/** Semantic comparison/storage form: node movement is deliberately ignored. */
export function serializeSemanticWorkflowDefinition(
  nodes: readonly FlowNodeDef[],
  edges: readonly FlowEdgeDef[],
): WorkflowDefinition {
  const definition = serializeWorkflowDefinition(nodes, edges);
  return {
    ...definition,
    nodes: definition.nodes.map((node) => ({ ...node, x: 0, y: 0 })),
  };
}

export function serializeWorkflowLayout(
  nodes: readonly FlowNodeDef[],
): WorkflowDefinitionLayout {
  return {
    nodes: Object.fromEntries(
      nodes.map((node) => [node.id, { x: Math.round(node.x), y: Math.round(node.y) }]),
    ),
  };
}
