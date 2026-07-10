import type {
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionEdge,
  WorkflowDefinitionNode,
} from "@shared/contracts";

export type {
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionEdge,
  WorkflowDefinitionNode,
};

export type NodeRunStatus = "ok" | "warn" | "fail" | "pending";

export type RunStatusMap = Record<string, NodeRunStatus>;

export interface FlowNodeDef extends WorkflowDefinitionNode {
  locked?: boolean;
}

export type FlowEdgeDef = WorkflowDefinitionEdge;
