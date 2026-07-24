import type { JsonValue, WorkflowDefinitionV2 } from "@shared/contracts";

const PROSE_CONFIGURATION_KEYS = new Set([
  "body",
  "instructions",
  "message",
  "postComment",
  "prompt",
  "questions",
  "system",
  "title",
]);

function dataContractConfiguration(
  configuration: Record<string, JsonValue>,
): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(configuration).filter(
      ([key]) => !PROSE_CONFIGURATION_KEYS.has(key),
    ),
  );
}

export function workflowCatalogFingerprint(
  definition: WorkflowDefinitionV2,
): string {
  return JSON.stringify({
    nodes: definition.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      configuration: dataContractConfiguration(node.configuration),
      additionalInputs: node.additionalInputs.map((input) => ({
        name: input.name,
        schema: input.schema,
      })),
    })),
    edges: definition.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      fromPort: edge.fromPort,
    })),
  });
}
