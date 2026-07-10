import type {
  BlockRunStatus,
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionEdge,
  WorkflowDefinitionNode,
} from "@shared/contracts";

export type {
  BlockRunStatus,
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionEdge,
  WorkflowDefinitionNode,
};

export type NodeRunStatus = BlockRunStatus;

export type RunStatusMap = Record<string, NodeRunStatus>;

export interface FlowNodeDef extends WorkflowDefinitionNode {
  locked?: boolean;
}

export type FlowEdgeDef = WorkflowDefinitionEdge;
