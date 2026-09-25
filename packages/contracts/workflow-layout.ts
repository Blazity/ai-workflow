import type {
  WorkflowDefinition,
  WorkflowDefinitionLayout,
} from "./domain";

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

export const EMPTY_WORKFLOW_DEFINITION_LAYOUT: WorkflowDefinitionLayout =
  Object.freeze({
    nodes: Object.freeze({}),
    edges: Object.freeze({}),
  });

/** Normalize the legacy `{ nodes }` representation to the canonical shape. */
export function normalizeWorkflowDefinitionLayout(
  value: unknown,
): WorkflowDefinitionLayout {
  if (!isRecord(value) || !isRecord(value.nodes)) {
    return EMPTY_WORKFLOW_DEFINITION_LAYOUT;
  }
  const nodes: WorkflowDefinitionLayout["nodes"] = {};
  for (const [nodeId, position] of Object.entries(value.nodes)) {
    if (
      nodeId &&
      isRecord(position) &&
      Number.isFinite(position.x) &&
      Number.isFinite(position.y)
    ) {
      nodes[nodeId] = {
        x: position.x as number,
        y: position.y as number,
      };
    }
  }
  const edges: WorkflowDefinitionLayout["edges"] = {};
  if (isRecord(value.edges)) {
    for (const [edgeId, geometry] of Object.entries(value.edges)) {
      if (
        edgeId &&
        isRecord(geometry) &&
        isRecord(geometry.bend) &&
        Number.isFinite(geometry.bend.x) &&
        Number.isFinite(geometry.bend.y)
      ) {
        edges[edgeId] = {
          bend: {
            x: geometry.bend.x as number,
            y: geometry.bend.y as number,
          },
        };
      }
    }
  }
  return {
    nodes,
    edges,
  };
}

/**
 * A stored graph with the definition's layout put back on it.
 *
 * The store keeps positions apart from the graph (a version is saved with every
 * node at 0,0, so moving a block never mints a version or changes its hash) and
 * one layout per definition. Every reader that shows or hands back a graph for
 * editing applies it here, so they agree on where a node sits. A node the
 * layout has no entry for keeps the coordinates it carries.
 */
export function applyWorkflowDefinitionLayout(
  definition: WorkflowDefinition,
  layout: WorkflowDefinitionLayout,
): WorkflowDefinition {
  return {
    ...definition,
    nodes: definition.nodes.map((node) => {
      const position = layout.nodes[node.id];
      return position ? { ...node, ...position } : node;
    }),
  } as WorkflowDefinition;
}
