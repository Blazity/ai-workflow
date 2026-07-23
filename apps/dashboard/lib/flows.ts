import type {
  BlockRunStatus,
  JsonValue,
  PromptSourceRef,
  WorkflowAdditionalInputV2,
  WorkflowBindingSource,
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionV1,
  WorkflowDefinitionV2,
  WorkflowInputBindingV2,
  WorkflowParamValue,
} from "@shared/contracts";

export type {
  BlockRunStatus,
  WorkflowBlockType,
  WorkflowDefinition,
};

export type NodeRunStatus = BlockRunStatus;

export type RunStatusMap = Record<string, NodeRunStatus>;

/** Version-neutral canvas shape. V2-only persisted data stays together so the
 * existing v1 inspector cannot accidentally rewrite nested JSON configuration. */
export interface FlowNodeDef {
  id: string;
  type: WorkflowBlockType;
  name?: string;
  x: number;
  y: number;
  params: Record<string, WorkflowParamValue>;
  promptRefs?: Record<string, PromptSourceRef>;
  inputs: Record<string, WorkflowBindingSource>;
  v2?: {
    configuration: Record<string, JsonValue>;
    inputs: Record<string, WorkflowInputBindingV2>;
    additionalInputs: WorkflowAdditionalInputV2[];
  };
  locked?: boolean;
}

export interface FlowEdgeDef {
  id?: string;
  from: string;
  to: string;
  fromPort?: string;
}

export function isFlowDisplayParamValue(
  value: JsonValue,
): value is WorkflowParamValue {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

function displayParams(
  configuration: Record<string, JsonValue>,
): Record<string, WorkflowParamValue> {
  return Object.fromEntries(
    Object.entries(configuration).filter(([, value]) =>
      isFlowDisplayParamValue(value),
    ),
  ) as Record<string, WorkflowParamValue>;
}

export function toFlowDefinition(definition: WorkflowDefinition): {
  schemaVersion: 1 | 2;
  nodes: FlowNodeDef[];
  edges: FlowEdgeDef[];
} {
  if (definition.schemaVersion === 1) {
    return {
      schemaVersion: 1,
      nodes: definition.nodes.map((node) => ({
        ...structuredClone(node),
        type: node.type,
      })),
      edges: structuredClone(definition.edges),
    };
  }
  return {
    schemaVersion: 2,
    nodes: definition.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      ...(node.name === undefined ? {} : { name: node.name }),
      x: node.x,
      y: node.y,
      params: displayParams(node.configuration),
      inputs: {},
      v2: {
        configuration: structuredClone(node.configuration),
        inputs: structuredClone(node.inputs),
        additionalInputs: structuredClone(node.additionalInputs),
      },
    })),
    edges: structuredClone(definition.edges),
  };
}

export function fromFlowDefinitionV1Node(
  node: FlowNodeDef,
): WorkflowDefinitionV1["nodes"][number] {
  return {
    id: node.id,
    type: node.type as WorkflowDefinitionV1["nodes"][number]["type"],
    x: node.x,
    y: node.y,
    params: node.params,
    ...(node.promptRefs === undefined ? {} : { promptRefs: node.promptRefs }),
    inputs: node.inputs,
    ...(node.name === undefined ? {} : { name: node.name }),
  };
}

export function fromFlowDefinitionV2Node(
  node: FlowNodeDef,
): WorkflowDefinitionV2["nodes"][number] {
  return {
    id: node.id,
    type: node.type,
    ...(node.name === undefined ? {} : { name: node.name }),
    x: node.x,
    y: node.y,
    configuration: structuredClone(node.v2?.configuration ?? {}),
    inputs: structuredClone(node.v2?.inputs ?? {}),
    additionalInputs: structuredClone(node.v2?.additionalInputs ?? []),
  };
}
