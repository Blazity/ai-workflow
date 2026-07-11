import type {
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionNode,
  WorkflowParamValue,
} from "@shared/contracts";
import type { FlowEdgeDef, FlowNodeDef } from "@/lib/flows";

const PARAM_KEYS: Record<WorkflowBlockType, string[]> = {
  trigger_ticket_ai: [],
  planning_agent: ["provider", "model"],
  implementation_agent: ["provider", "model"],
  review_agent: ["provider", "model"],
  run_pre_pr_checks: ["maxFixCycles"],
  open_pr: [],
  update_ticket_status: ["target"],
  send_slack_message: ["message"],
  branch: ["condition"],
  loop: ["maxAttempts", "onExhaust"],
  terminate: ["terminalStatus", "postComment"],
};

function serializeParams(node: FlowNodeDef): Record<string, WorkflowParamValue> {
  const out: Record<string, WorkflowParamValue> = {};
  for (const key of PARAM_KEYS[node.type]) {
    const value = node.params[key];
    if (value === undefined) continue;
    if ((key === "model" || key === "message" || key === "provider") && value === "") continue;
    out[key] = value;
  }
  return out;
}

export function serializeWorkflowDefinition(
  nodes: readonly FlowNodeDef[],
  edges: readonly FlowEdgeDef[],
): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: nodes.map((node) => {
      const serialized: WorkflowDefinitionNode = {
        id: node.id,
        type: node.type,
        x: Math.round(node.x),
        y: Math.round(node.y),
        params: serializeParams(node),
      };
      if (node.name !== undefined) serialized.name = node.name;
      return serialized;
    }),
    edges: edges.map((edge) => ({ from: edge.from, to: edge.to })),
  };
}
