import type {
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionEdge,
  WorkflowDefinitionNode,
  WorkflowParamValue,
} from "@shared/contracts";
import type { FlowEdgeDef, FlowNodeDef } from "@/lib/flows";
import { canOmitFromPort } from "./edges";

const PARAM_KEYS: Record<WorkflowBlockType, string[]> = {
  trigger_ticket_ai: [],
  trigger_plan_approved: ["source"],
  trigger_pr_created: ["providers", "onlyWorkflowOwned"],
  trigger_pr_checks_failed: ["providers"],
  trigger_pr_review: ["providers", "on"],
  planning_agent: ["provider", "model"],
  implementation_agent: ["provider", "model"],
  review_agent: ["provider", "model"],
  fix_agent: ["provider", "model", "instructions", "maxMinutes"],
  generic_agent: ["provider", "model", "prompt", "outputSchema"],
  prepare_workspace: [],
  finalize_workspace: ["requiredChecks"],
  run_pre_pr_checks: ["maxFixCycles"],
  run_checks: ["commands"],
  call_llm: ["prompt", "system", "model", "outputSchema"],
  fetch_pr_context: [],
  open_pr: [],
  update_ticket_status: ["target"],
  post_ticket_comment: ["body"],
  post_pr_comment: ["body", "target"],
  send_slack_message: ["message"],
  send_plan_approval: ["planFromStep", "mirrorComment"],
  human_question: ["questions"],
  arthur_injection_check: ["contentFromStep"],
  arthur_trace: ["taskName"],
  branch: ["condition"],
  loop: ["maxAttempts", "onExhaust"],
  terminate: ["terminalStatus", "postComment"],
};

function serializeParams(node: FlowNodeDef): Record<string, WorkflowParamValue> {
  const out: Record<string, WorkflowParamValue> = {};
  for (const key of PARAM_KEYS[node.type]) {
    const value = node.params[key];
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    out[key] = value;
  }
  return out;
}

export function serializeWorkflowDefinition(
  nodes: readonly FlowNodeDef[],
  edges: readonly FlowEdgeDef[],
): WorkflowDefinition {
  const typeById = new Map(nodes.map((node) => [node.id, node.type]));
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
    edges: edges.map((edge) => {
      const serialized: WorkflowDefinitionEdge = { from: edge.from, to: edge.to };
      const sourceType = typeById.get(edge.from);
      if (
        edge.fromPort !== undefined &&
        !(sourceType !== undefined && canOmitFromPort(sourceType, edge.fromPort))
      ) {
        serialized.fromPort = edge.fromPort;
      }
      return serialized;
    }),
  };
}
