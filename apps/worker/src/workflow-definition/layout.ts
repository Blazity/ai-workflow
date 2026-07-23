import type {
  WorkflowDefinition,
  WorkflowDefinitionLayout,
  WorkflowDefinitionV1,
  WorkflowDefinitionV2,
} from "@shared/contracts";

export const EMPTY_WORKFLOW_LAYOUT: WorkflowDefinitionLayout = { nodes: {} };

/** Strip presentation coordinates from the semantic graph deterministically. */
export function canonicalizeWorkflowDefinition(
  definition: WorkflowDefinitionV1,
): WorkflowDefinitionV1;
export function canonicalizeWorkflowDefinition(
  definition: WorkflowDefinitionV2,
): WorkflowDefinitionV2;
export function canonicalizeWorkflowDefinition(
  definition: WorkflowDefinition,
): WorkflowDefinition;
export function canonicalizeWorkflowDefinition(
  definition: WorkflowDefinition,
): WorkflowDefinition {
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

export function extractWorkflowDefinitionLayout(
  definition: WorkflowDefinition,
): WorkflowDefinitionLayout {
  return {
    nodes: Object.fromEntries(
      definition.nodes.map((node) => [node.id, { x: node.x, y: node.y }]),
    ),
  };
}

/** Unknown/deleted node keys are harmless; new nodes keep their semantic zero. */
export function applyWorkflowDefinitionLayout(
  definition: WorkflowDefinitionV1,
  layout: WorkflowDefinitionLayout,
): WorkflowDefinitionV1;
export function applyWorkflowDefinitionLayout(
  definition: WorkflowDefinitionV2,
  layout: WorkflowDefinitionLayout,
): WorkflowDefinitionV2;
export function applyWorkflowDefinitionLayout(
  definition: WorkflowDefinition,
  layout: WorkflowDefinitionLayout,
): WorkflowDefinition;
export function applyWorkflowDefinitionLayout(
  definition: WorkflowDefinition,
  layout: WorkflowDefinitionLayout,
): WorkflowDefinition {
  if (definition.schemaVersion === 1) {
    return {
      ...definition,
      nodes: definition.nodes.map((node) => {
        const position = layout.nodes[node.id];
        return position ? { ...node, ...position } : node;
      }),
    };
  }
  return {
    ...definition,
    nodes: definition.nodes.map((node) => {
      const position = layout.nodes[node.id];
      return position ? { ...node, ...position } : node;
    }),
  };
}
