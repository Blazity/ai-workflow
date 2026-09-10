import type {
  BlockRunStatus,
  JsonValue,
  PromptSourceRef,
  WorkflowAdditionalInputV2,
  WorkflowBindingSource,
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionV2,
  WorkflowDefinitionVersion,
  WorkflowInputBindingV2,
  WorkflowParamValue,
} from "@shared/contracts";

export type {
  BlockRunStatus,
  WorkflowBlockType,
  WorkflowDefinition,
};

/** The graph of a stored version the editor can still open on the canvas. A
 *  retired v1 version stays listed and readable in history and answers null
 *  here, so nothing loads it into an editor that can only author v2. */
export function runnableVersionDefinition(
  version: WorkflowDefinitionVersion | null | undefined,
): WorkflowDefinition | null {
  return version?.schema === "v2" ? version.definition : null;
}

export type NodeRunStatus = BlockRunStatus;

export type RunStatusMap = Record<string, NodeRunStatus>;

/** Canvas shape. The persisted v2 payload stays together under `v2` so the
 * display-value inspector cannot rewrite nested JSON configuration. */
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
  nodes: FlowNodeDef[];
  edges: FlowEdgeDef[];
} {
  return {
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
