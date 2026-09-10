import type { ReactNode } from "react";
import type { FlowNodeDef } from "@/lib/flows";
import type { PromptSourceRef, WorkflowEditorOptions, WorkflowParamValue } from "@shared/contracts";

export type ConfigChange = (
  path: string,
  value: WorkflowParamValue | PromptSourceRef | undefined,
) => void;

export interface BlockRendererProps {
  node: FlowNodeDef;
  options: WorkflowEditorOptions;
  canEdit: boolean;
  onChange: ConfigChange;
}

export type BlockRenderer = (props: BlockRendererProps) => ReactNode;
