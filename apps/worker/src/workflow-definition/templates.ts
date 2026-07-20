import type {
  WorkflowDefinition,
  WorkflowDefinitionEdge,
  WorkflowDefinitionNode,
  WorkflowDefinitionTemplate,
} from "@shared/contracts";
import { defaultWorkflowDefinition } from "./default.js";
import {
  buildEdge,
  buildNode,
  planApprovalDefinition,
  prReviewFixDefinition,
} from "./graph-fixtures.js";

export const DEFAULT_WORKFLOW_TEMPLATE_ID = "ticket-workflow";

function fullyModularDefinition(): WorkflowDefinition {
  const planningOutput = JSON.stringify({
    type: "object",
    properties: { plan: { type: "string" } },
    required: ["plan"],
    additionalProperties: false,
  });
  const implementationOutput = JSON.stringify({
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
    additionalProperties: false,
  });
  const nodes: WorkflowDefinitionNode[] = [
    buildNode({ id: "trigger", type: "trigger_ticket_ai", name: "Ticket assigned to AI" }, 0),
    buildNode(
      {
        id: "planning",
        type: "generic_agent",
        name: "Generic agent — planning",
        params: {
          prompt: "Produce an implementation plan for this ticket.",
          outputSchema: planningOutput,
          workspaceMode: "none",
        },
      },
      1,
    ),
    buildNode({ id: "prepare", type: "prepare_workspace", name: "Prepare workspace" }, 2),
    buildNode(
      {
        id: "implementation",
        type: "generic_agent",
        name: "Generic agent — implementation",
        params: { outputSchema: implementationOutput, workspaceMode: "read_write" },
        inputs: { prompt: "steps.planning.output.plan" },
      },
      3,
    ),
    buildNode({ id: "checks", type: "run_checks", name: "Run checks" }, 4),
    buildNode(
      {
        id: "checks_ok",
        type: "branch",
        name: "All checks pass?",
        params: { condition: "steps.checks.output.ok" },
      },
      5,
    ),
    buildNode(
      { id: "retry", type: "loop", name: "Retry fixes", params: { maxAttempts: 3, onExhaust: "fail" } },
      5,
      1,
    ),
    buildNode({ id: "fix", type: "fix_agent", name: "Fix agent" }, 4, 1),
    buildNode({ id: "finalize", type: "finalize_workspace", name: "Finalize workspace" }, 6),
    buildNode(
      {
        id: "open_pr",
        type: "open_pr",
        name: "Open pull request",
        inputs: { repositories: "steps.finalize.output.repositories" },
      },
      7,
    ),
  ];
  const edges: WorkflowDefinitionEdge[] = [
    buildEdge("trigger", "planning"),
    buildEdge("planning", "prepare"),
    buildEdge("prepare", "implementation"),
    buildEdge("implementation", "checks"),
    buildEdge("checks", "checks_ok"),
    buildEdge("checks_ok", "finalize", "true"),
    buildEdge("checks_ok", "retry", "false"),
    buildEdge("retry", "fix", "continue"),
    buildEdge("fix", "checks"),
    buildEdge("finalize", "open_pr"),
  ];
  return { schemaVersion: 1, nodes, edges };
}

function reviewFixAfterPrDefinition(): WorkflowDefinition {
  const definition = prReviewFixDefinition();
  return {
    ...definition,
    nodes: definition.nodes.map((node) =>
      node.type === "trigger_pr_checks_failed"
        ? { ...node, params: { ...node.params, checkNames: ["CI"] } }
        : node,
    ),
  };
}

export function workflowDefinitionTemplates({
  includeReview,
}: {
  includeReview: boolean;
}): WorkflowDefinitionTemplate[] {
  return [
    {
      id: DEFAULT_WORKFLOW_TEMPLATE_ID,
      name: "Ticket workflow",
      description: "The current production delivery flow from ticket assignment through PR publication.",
      definition: defaultWorkflowDefinition({ includeReview }),
    },
    {
      id: "human-approved-plan",
      name: "Human-approved plan",
      description: "Plans first, waits for approval, then implements the approved plan.",
      definition: planApprovalDefinition(),
    },
    {
      id: "review-fix-after-pr",
      name: "Review & fix after PR",
      description: "Responds to failed checks or requested changes on workflow-owned pull requests.",
      definition: reviewFixAfterPrDefinition(),
    },
    {
      id: "fully-modular",
      name: "Fully modular",
      description: "Builds delivery from generic agents, workspace, checks, branch, and loop blocks.",
      definition: fullyModularDefinition(),
    },
  ];
}

export function workflowDefinitionTemplate(
  id: string,
  options: { includeReview: boolean },
): WorkflowDefinitionTemplate | null {
  return workflowDefinitionTemplates(options).find((template) => template.id === id) ?? null;
}
