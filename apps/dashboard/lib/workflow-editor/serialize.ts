import {
  BLOCK_PARAM_KEYS,
  isHarnessProfileReference,
  isV2AgentBlockType,
} from "@shared/contracts";
import type {
  WorkflowDefinition,
  WorkflowEdgeGeometry,
  WorkflowDefinitionLayout,
  WorkflowDefinitionV2,
  WorkflowExecutionBudgets,
  WorkflowParamValue,
  WorkflowRepositoryScope,
} from "@shared/contracts";
import {
  fromFlowDefinitionV2Node,
  isFlowDisplayParamValue,
  type FlowEdgeDef,
  type FlowNodeDef,
} from "@/lib/flows";
import { canOmitFromPort } from "./edges";
import {
  isRepositoryScopeEmpty,
  normalizeRepositoryScope,
} from "./repository-scope";

// The canonical param-key allowlist lives in @shared/contracts (BLOCK_PARAM_KEYS).
// Import it rather than keeping a dashboard copy so the two can never drift (a
// stale copy previously stripped call_llm's `provider` on save).

/**
 * The keys this block's params may carry.
 *
 * `BLOCK_PARAM_KEYS` covers the block types core owns. An integration's block
 * type is storable (`isStorableWorkflowBlockType`) and has no row there, and it
 * cannot have one: the keys come from the integration's own `paramsSchema` and
 * the graph package may not read a manifest. So a type the allowlist does not
 * cover keeps the keys the node actually holds, which the editor only ever
 * filled from that block's own contract, and the worker validates them against
 * the schema that owns them. Reading the table directly threw
 * "BLOCK_PARAM_KEYS[node.type] is not iterable" the moment an integration block
 * reached the canvas, which took the whole editor down.
 */
function paramKeysOf(node: FlowNodeDef): readonly string[] {
  return BLOCK_PARAM_KEYS[node.type] ?? Object.keys(node.params);
}

function serializeParams(node: FlowNodeDef): Record<string, WorkflowParamValue> {
  const out: Record<string, WorkflowParamValue> = {};
  for (const key of paramKeysOf(node)) {
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
  repositoryScope: WorkflowRepositoryScope = {},
): WorkflowDefinition {
  const typeById = new Map(nodes.map((node) => [node.id, node.type]));
  const hasBudgets = Object.values(budgets).some((value) => value !== undefined);
  const scope = normalizeRepositoryScope(repositoryScope);
  const pin = isRepositoryScopeEmpty(scope) ? {} : { repositoryScope: scope };
  const definition: WorkflowDefinitionV2 = {
    schemaVersion: 2,
    ...(hasBudgets ? { budgets: { ...budgets } } : {}),
    ...pin,
    nodes: nodes.map((node) => {
      const serialized = fromFlowDefinitionV2Node({
        ...node,
        x: Math.round(node.x),
        y: Math.round(node.y),
      });
      const displayed = serializeParams(node);
      for (const key of paramKeysOf(node)) {
        if (displayed[key] !== undefined) {
          serialized.configuration[key] = displayed[key];
        } else if (
          serialized.configuration[key] !== undefined &&
          isFlowDisplayParamValue(serialized.configuration[key])
        ) {
          delete serialized.configuration[key];
        }
      }
      if (
        isV2AgentBlockType(node.type) &&
        isHarnessProfileReference(
          serialized.configuration.harnessProfile,
        )
      ) {
        delete serialized.configuration.provider;
        delete serialized.configuration.model;
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
  budgets: WorkflowExecutionBudgets = {},
  repositoryScope: WorkflowRepositoryScope = {},
): WorkflowDefinition {
  const definition = serializeWorkflowDefinition(
    nodes,
    edges,
    budgets,
    repositoryScope,
  );
  return {
    ...definition,
    nodes: definition.nodes.map((node) => Object.assign({}, node, { x: 0, y: 0 })),
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
