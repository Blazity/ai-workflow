import type {
  WorkflowBlockTypeV1,
  WorkflowDefinitionV1,
  WorkflowDefinitionNode,
  WorkflowParamValue,
} from "@shared/contracts";

interface BlockSpec {
  id: string;
  type: WorkflowBlockTypeV1;
  name: string;
  params: Record<string, WorkflowParamValue>;
  inputs?: WorkflowDefinitionNode["inputs"];
}

export function defaultWorkflowDefinition({
  includeReview,
}: {
  includeReview: boolean;
}): WorkflowDefinitionV1 {
  const specs: BlockSpec[] = [
    { id: "trigger", type: "trigger_ticket_ai", name: "Ticket assigned to AI", params: {} },
    {
      id: "planning",
      type: "planning_agent",
      name: "Planning agent",
      params: {},
      inputs: {
        ticket: "trigger.ticket",
        comments: "trigger.comments",
        priorAnswers: "trigger.priorAnswers",
      },
    },
    {
      id: "implementation",
      type: "implementation_agent",
      name: "Implementation agent",
      params: {},
      inputs: {
        ticket: "trigger.ticket",
        plan: "steps.planning.output.plan",
      },
    },
    ...(includeReview
      ? [{ id: "review", type: "review_agent", name: "Review agent", params: {} } satisfies BlockSpec]
      : []),
    { id: "checks", type: "run_pre_pr_checks", name: "Run pre-PR checks", params: {} },
    { id: "finalize", type: "finalize_workspace", name: "Finalize workspace", params: {} },
    {
      id: "open-pr",
      type: "open_pr",
      name: "Open pull request",
      params: {},
      inputs: { repositories: "steps.finalize.output.repositories" },
    },
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
    inputs: spec.inputs ?? {},
  }));

  const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id }));

  return { schemaVersion: 1, nodes, edges };
}
