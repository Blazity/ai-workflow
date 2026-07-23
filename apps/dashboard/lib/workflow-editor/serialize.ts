import { BLOCK_PARAM_KEYS } from "@shared/contracts";
import type {
  WorkflowDefinition,
  WorkflowEdgeGeometry,
  WorkflowDefinitionLayout,
  WorkflowDefinitionV1,
  WorkflowDefinitionV2,
  WorkflowExecutionBudgets,
  WorkflowParamValue,
} from "@shared/contracts";
import {
  fromFlowDefinitionV1Node,
  fromFlowDefinitionV2Node,
  isFlowDisplayParamValue,
  type FlowEdgeDef,
  type FlowNodeDef,
} from "@/lib/flows";
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
  budgets?: WorkflowExecutionBudgets,
): WorkflowDefinitionV1;
export function serializeWorkflowDefinition(
  nodes: readonly FlowNodeDef[],
  edges: readonly FlowEdgeDef[],
  budgets: WorkflowExecutionBudgets,
  schemaVersion: 1,
): WorkflowDefinitionV1;
export function serializeWorkflowDefinition(
  nodes: readonly FlowNodeDef[],
  edges: readonly FlowEdgeDef[],
  budgets: WorkflowExecutionBudgets,
  schemaVersion: 2,
): WorkflowDefinitionV2;
export function serializeWorkflowDefinition(
  nodes: readonly FlowNodeDef[],
  edges: readonly FlowEdgeDef[],
  budgets: WorkflowExecutionBudgets,
  schemaVersion: 1 | 2,
): WorkflowDefinition;
export function serializeWorkflowDefinition(
  nodes: readonly FlowNodeDef[],
  edges: readonly FlowEdgeDef[],
  budgets: WorkflowExecutionBudgets = {},
  schemaVersion: 1 | 2 = 1,
): WorkflowDefinition {
  const typeById = new Map(nodes.map((node) => [node.id, node.type]));
  const hasBudgets = Object.values(budgets).some((value) => value !== undefined);
  if (schemaVersion === 1) {
    const definition: WorkflowDefinitionV1 = {
      schemaVersion: 1,
      ...(hasBudgets ? { budgets: { ...budgets } } : {}),
      nodes: nodes.map((node) => {
        const serialized = fromFlowDefinitionV1Node({
          ...node,
          x: Math.round(node.x),
          y: Math.round(node.y),
          params: serializeParams(node),
        });
        if (serialized.promptRefs) {
          const kept = Object.fromEntries(
            Object.entries(serialized.promptRefs).filter(
              ([key]) => serialized.params[key] !== undefined,
            ),
          );
          if (Object.keys(kept).length > 0) serialized.promptRefs = kept;
          else delete serialized.promptRefs;
        }
        return serialized;
      }),
      edges: edges.map((edge) => {
        const serialized: WorkflowDefinitionV1["edges"][number] = {
          from: edge.from,
          to: edge.to,
        };
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
    return definition;
  }

  const definition: WorkflowDefinitionV2 = {
    schemaVersion: 2,
    ...(hasBudgets ? { budgets: { ...budgets } } : {}),
    nodes: nodes.map((node) => {
      const serialized = fromFlowDefinitionV2Node({
        ...node,
        x: Math.round(node.x),
        y: Math.round(node.y),
      });
      const displayed = serializeParams(node);
      for (const key of BLOCK_PARAM_KEYS[node.type]) {
        if (displayed[key] !== undefined) {
          serialized.configuration[key] = displayed[key];
        } else if (
          serialized.configuration[key] !== undefined &&
          isFlowDisplayParamValue(serialized.configuration[key])
        ) {
          delete serialized.configuration[key];
        }
      }
      return serialized;
    }),
    edges: edges.map((edge, index) => {
      const serialized: WorkflowDefinitionV2["edges"][number] = {
        id:
          edge.id ??
          `v2-edge-${index}-${edge.from}-${edge.fromPort ?? "out"}-${edge.to}`,
        from: edge.from,
        to: edge.to,
      };
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
  return definition;
}

/** Semantic comparison/storage form: node movement is deliberately ignored. */
export function serializeSemanticWorkflowDefinition(
  nodes: readonly FlowNodeDef[],
  edges: readonly FlowEdgeDef[],
  budgets?: WorkflowExecutionBudgets,
): WorkflowDefinitionV1;
export function serializeSemanticWorkflowDefinition(
  nodes: readonly FlowNodeDef[],
  edges: readonly FlowEdgeDef[],
  budgets: WorkflowExecutionBudgets,
  schemaVersion: 1,
): WorkflowDefinitionV1;
export function serializeSemanticWorkflowDefinition(
  nodes: readonly FlowNodeDef[],
  edges: readonly FlowEdgeDef[],
  budgets: WorkflowExecutionBudgets,
  schemaVersion: 2,
): WorkflowDefinitionV2;
export function serializeSemanticWorkflowDefinition(
  nodes: readonly FlowNodeDef[],
  edges: readonly FlowEdgeDef[],
  budgets: WorkflowExecutionBudgets,
  schemaVersion: 1 | 2,
): WorkflowDefinition;
export function serializeSemanticWorkflowDefinition(
  nodes: readonly FlowNodeDef[],
  edges: readonly FlowEdgeDef[],
  budgets: WorkflowExecutionBudgets = {},
  schemaVersion: 1 | 2 = 1,
): WorkflowDefinition {
  const definition = serializeWorkflowDefinition(nodes, edges, budgets, schemaVersion);
  if (definition.schemaVersion === 1) {
    return {
      ...definition,
      nodes: definition.nodes.map((node) => ({ ...node, x: 0, y: 0 })),
    };
  }
  return {
    ...definition,
    nodes: definition.nodes.map((node) => ({ ...node, x: 0, y: 0 })),
  };
}

export function serializeWorkflowLayout(
  nodes: readonly FlowNodeDef[],
  edgeGeometry: Readonly<Record<string, WorkflowEdgeGeometry>> = {},
): WorkflowDefinitionLayout {
  return {
    nodes: Object.fromEntries(
      nodes.map((node) => [node.id, { x: Math.round(node.x), y: Math.round(node.y) }]),
    ),
    edges: Object.fromEntries(
      Object.entries(edgeGeometry).map(([edgeId, geometry]) => [
        edgeId,
        {
          bend: {
            x: Math.round(geometry.bend.x),
            y: Math.round(geometry.bend.y),
          },
        },
      ]),
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
  edgeGeometry: Readonly<Record<string, WorkflowEdgeGeometry>> =
    baseline.edges ?? {},
): WorkflowDefinitionLayout {
  const current = serializeWorkflowLayout(nodes, edgeGeometry);
  return {
    nodes: { ...baseline.nodes, ...current.nodes },
    edges: current.edges,
  };
}
