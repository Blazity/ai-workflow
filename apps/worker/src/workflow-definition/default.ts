import type {
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionNode,
  WorkflowParamValue,
} from "@shared/contracts";

interface BlockSpec {
  id: string;
  type: WorkflowBlockType;
  name: string;
  params: Record<string, WorkflowParamValue>;
}

export function defaultWorkflowDefinition({ includeReview }: { includeReview: boolean }): WorkflowDefinition {
  const specs: BlockSpec[] = [
    { id: "trigger", type: "trigger_ticket_ai", name: "Ticket assigned to AI", params: {} },
    { id: "planning", type: "planning_agent", name: "Planning agent", params: {} },
    { id: "implementation", type: "implementation_agent", name: "Implementation agent", params: {} },
    ...(includeReview
      ? [{ id: "review", type: "review_agent", name: "Review agent", params: {} } satisfies BlockSpec]
      : []),
    { id: "checks", type: "run_pre_pr_checks", name: "Run pre-PR checks", params: {} },
    { id: "open-pr", type: "open_pr", name: "Open pull request", params: {} },
    { id: "slack", type: "send_slack_message", name: "Send Slack message", params: {} },
    { id: "status", type: "update_ticket_status", name: "Update ticket status", params: { target: "ai_review" } },
  ];

  const startX = 40;
  const stepX = 260;
  const y = 280;

  const nodes: WorkflowDefinitionNode[] = specs.map((spec, index) => ({
    id: spec.id,
    type: spec.type,
    name: spec.name,
    x: startX + index * stepX,
    y,
    params: spec.params,
  }));

  const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id }));

  return { schemaVersion: 1, nodes, edges };
}
