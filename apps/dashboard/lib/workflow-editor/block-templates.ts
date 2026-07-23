import type { FlowEdgeDef, FlowNodeDef } from "@/lib/flows";
import type {
  JsonValue,
  WorkflowParamValue,
} from "@shared/contracts";

export type WorkflowEditorBlockTemplateId =
  | "review-with-decision"
  | "checks-with-result";

export interface WorkflowEditorBlockTemplate {
  id: WorkflowEditorBlockTemplateId;
  sourceType: "review_agent" | "run_checks";
  name: string;
  description: string;
}

export const WORKFLOW_EDITOR_BLOCK_TEMPLATES: readonly WorkflowEditorBlockTemplate[] = [
  {
    id: "review-with-decision",
    sourceType: "review_agent",
    name: "Review with decision",
    description: "Adds a Review agent followed by an editable approval Branch.",
  },
  {
    id: "checks-with-result",
    sourceType: "run_checks",
    name: "Checks with result",
    description: "Adds Run checks followed by an editable passed-result Branch.",
  },
];

function allocateNodeId(base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function allocateEdgeId(
  used: Set<string>,
  generateEdgeId: () => string,
): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = generateEdgeId();
    if (candidate !== "" && !used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  return allocateNodeId("edge", used);
}

function descriptor(
  templateId: WorkflowEditorBlockTemplateId,
): WorkflowEditorBlockTemplate {
  const value = WORKFLOW_EDITOR_BLOCK_TEMPLATES.find(
    (candidate) => candidate.id === templateId,
  );
  if (!value) throw new Error(`Unknown workflow editor block template: ${templateId}`);
  return value;
}

export function instantiateWorkflowEditorBlockTemplate(options: {
  templateId: WorkflowEditorBlockTemplateId;
  sourceName: string;
  sourceParams: Record<string, WorkflowParamValue>;
  position: { x: number; y: number };
  existingNodes: readonly Pick<FlowNodeDef, "id">[];
  existingEdges: readonly Pick<FlowEdgeDef, "id">[];
  generateEdgeId?: () => string;
}): {
  nodes: [FlowNodeDef, FlowNodeDef];
  edges: [FlowEdgeDef];
  selectedNodeId: string;
} {
  const template = descriptor(options.templateId);
  const usedNodeIds = new Set(options.existingNodes.map((node) => node.id));
  const usedEdgeIds = new Set(
    options.existingEdges
      .map((edge) => edge.id)
      .filter((id): id is string => id !== undefined),
  );
  const sourceBase =
    template.sourceType === "review_agent" ? "review" : "checks";
  const branchBase =
    template.sourceType === "review_agent"
      ? "review-decision"
      : "checks-result";
  const sourceId = allocateNodeId(sourceBase, usedNodeIds);
  const branchId = allocateNodeId(branchBase, usedNodeIds);
  const branchName =
    template.sourceType === "review_agent"
      ? "Review approved?"
      : "Checks passed?";
  const comparedField =
    template.sourceType === "review_agent" ? "decision" : "outcome";
  const expected =
    template.sourceType === "review_agent" ? "approve" : "passed";
  const sourceConfiguration = structuredClone(
    options.sourceParams,
  ) as Record<string, JsonValue>;

  const sourceNode: FlowNodeDef = {
    id: sourceId,
    type: template.sourceType,
    name: options.sourceName,
    x: options.position.x,
    y: options.position.y,
    params: structuredClone(options.sourceParams),
    inputs: {},
    v2: {
      configuration: sourceConfiguration,
      inputs: {},
      additionalInputs: [],
    },
  };
  const branchNode: FlowNodeDef = {
    id: branchId,
    type: "branch",
    name: branchName,
    x: options.position.x + 270,
    y: options.position.y,
    params: {},
    inputs: {},
    v2: {
      configuration: {
        condition: {
          kind: "eq",
          left: {
            kind: "path",
            reference: `steps.${sourceId}.output.${comparedField}`,
          },
          right: { kind: "lit", value: expected },
        },
      },
      inputs: {},
      additionalInputs: [],
    },
  };
  const edge: FlowEdgeDef = {
    id: allocateEdgeId(
      usedEdgeIds,
      options.generateEdgeId ?? (() => globalThis.crypto.randomUUID()),
    ),
    from: sourceId,
    to: branchId,
  };
  return {
    nodes: [sourceNode, branchNode],
    edges: [edge],
    selectedNodeId: branchId,
  };
}
