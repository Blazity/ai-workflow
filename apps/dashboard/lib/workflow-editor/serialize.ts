import { BLOCK_PARAM_KEYS } from "@shared/contracts";
import type {
  WorkflowDefinition,
  WorkflowDefinitionEdge,
  WorkflowDefinitionLayout,
  WorkflowDefinitionNode,
  WorkflowExecutionBudgets,
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
  budgets: WorkflowExecutionBudgets = {},
): WorkflowDefinition {
  const typeById = new Map(nodes.map((node) => [node.id, node.type]));
  const hasBudgets = Object.values(budgets).some((value) => value !== undefined);
  return {
    schemaVersion: 1,
    ...(hasBudgets ? { budgets: { ...budgets } } : {}),
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
      if (node.promptRefs) {
        const kept = Object.fromEntries(
          Object.entries(node.promptRefs).filter(
            ([key]) => serialized.params[key] !== undefined,
          ),
        );
        if (Object.keys(kept).length > 0) serialized.promptRefs = kept;
      }
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
  budgets: WorkflowExecutionBudgets = {},
): WorkflowDefinition {
  const definition = serializeWorkflowDefinition(nodes, edges, budgets);
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

/**
 * Layout is intentionally independent from semantic draft edits. Preserve
 * persisted entries for nodes that are temporarily absent from the editor so
 * an unsaved deletion cannot erase their saved position. Extra entries for
 * unsaved additions are harmless and preserve their position if later saved.
 */
export function serializeWorkflowLayoutWithBaseline(
  nodes: readonly FlowNodeDef[],
  baseline: WorkflowDefinitionLayout,
): WorkflowDefinitionLayout {
  const current = serializeWorkflowLayout(nodes);
  return { nodes: { ...baseline.nodes, ...current.nodes } };
}
