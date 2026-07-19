import type {
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionEdge,
  WorkflowDefinitionNode,
  WorkflowParamValue,
} from "@shared/contracts";

export interface BlockSpec {
  id: string;
  type: WorkflowBlockType;
  params?: Record<string, WorkflowParamValue>;
  inputs?: WorkflowDefinitionNode["inputs"];
  name?: string;
}

/** Build a single node, placing it on an auto-assigned column/row grid. */
export function buildNode(spec: BlockSpec, column: number, row = 0): WorkflowDefinitionNode {
  return {
    id: spec.id,
    type: spec.type,
    name: spec.name,
    x: 40 + column * 220,
    y: 160 + row * 180,
    params: spec.params ?? {},
    inputs: spec.inputs ?? {},
  };
}

/** Build an edge, optionally leaving from a named source port. */
export function buildEdge(from: string, to: string, fromPort?: string): WorkflowDefinitionEdge {
  return fromPort === undefined ? { from, to } : { from, to, fromPort };
}

/** Build a fan-out-free linear chain: every block wires from its default port to the next. */
export function buildLinearChain(specs: BlockSpec[]): WorkflowDefinition {
  const nodes = specs.map((spec, index) => buildNode(spec, index));
  const edges = specs.slice(1).map((spec, index) => buildEdge(specs[index].id, spec.id));
  return { schemaVersion: 1, nodes, edges };
}

/**
 * A V1-shaped pipeline authored as a straight chain. V1 has no fan-out (frozen
 * decision), so every block hands off to exactly one successor via its default port.
 */
export function linearPipelineDefinition(): WorkflowDefinition {
  return buildLinearChain([
    { id: "trigger", type: "trigger_ticket_ai" },
    {
      id: "planning",
      type: "planning_agent",
      inputs: {
        ticket: "trigger.ticket",
        comments: "trigger.comments",
        priorAnswers: "trigger.priorAnswers",
      },
    },
    {
      id: "implementation",
      type: "implementation_agent",
      inputs: { ticket: "trigger.ticket", plan: "steps.planning.output.plan" },
    },
    { id: "checks", type: "run_pre_pr_checks" },
    { id: "finalize", type: "finalize_workspace" },
    {
      id: "open-pr",
      type: "open_pr",
      inputs: { publicationAttemptId: "steps.finalize.output.publicationAttemptId" },
    },
    { id: "slack", type: "send_slack_message" },
    { id: "status", type: "update_ticket_status", params: { target: "ai_review" } },
  ]);
}

export interface HumanGateLoopOptions {
  /**
   * Block type used for the in-loop "fix" agent. Defaults to review_agent as a
   * stand-in; later waves can pass a dedicated fix-agent type once it exists.
   */
  fixAgentType?: WorkflowBlockType;
}

/**
 * A V2-shaped graph that exercises branches, a terminate leaf, and a re-entrant
 * loop, using only the block types that exist today. The shape is:
 *   trigger -> planning -> gate(branch)
 *     gate --true--> notify -> halt(terminate)
 *     gate --false--> implementation -> checks -> verdict(branch)
 *       verdict --true--> open-pr
 *       verdict --false--> retry(loop) --continue--> fix -> back to checks
 * Parameterised so later waves can swap in real V3/V4 types for the stand-ins.
 */
export function humanGateLoopDefinition(options: HumanGateLoopOptions = {}): WorkflowDefinition {
  const fixAgentType = options.fixAgentType ?? "review_agent";
  const nodes: WorkflowDefinitionNode[] = [
    buildNode({ id: "trigger", type: "trigger_ticket_ai" }, 0),
    buildNode(
      {
        id: "planning",
        type: "planning_agent",
        inputs: {
          ticket: "trigger.ticket",
          comments: "trigger.comments",
          priorAnswers: "trigger.priorAnswers",
        },
      },
      1,
    ),
    buildNode(
      {
        id: "gate",
        type: "branch",
        params: { condition: 'steps.planning.output.status == "needs_human_input"' },
      },
      2,
    ),
    buildNode({ id: "notify", type: "send_slack_message" }, 3, 1),
    buildNode(
      { id: "halt", type: "terminate", params: { terminalStatus: "waiting_for_human" } },
      4,
      1,
    ),
    buildNode(
      {
        id: "implementation",
        type: "implementation_agent",
        inputs: { ticket: "trigger.ticket", plan: "steps.planning.output.plan" },
      },
      3,
    ),
    buildNode({ id: "checks", type: "run_pre_pr_checks" }, 4),
    buildNode({ id: "verdict", type: "branch", params: { condition: "steps.checks.output.ok" } }, 5),
    buildNode({ id: "finalize", type: "finalize_workspace" }, 6),
    buildNode(
      {
        id: "open-pr",
        type: "open_pr",
        inputs: { publicationAttemptId: "steps.finalize.output.publicationAttemptId" },
      },
      7,
    ),
    buildNode(
      { id: "retry", type: "loop", params: { maxAttempts: 3, onExhaust: "fail" } },
      6,
      1,
    ),
    buildNode({ id: "fix", type: fixAgentType }, 5, 1),
  ];
  const edges: WorkflowDefinitionEdge[] = [
    buildEdge("trigger", "planning"),
    buildEdge("planning", "gate"),
    buildEdge("gate", "notify", "true"),
    buildEdge("notify", "halt"),
    buildEdge("gate", "implementation", "false"),
    buildEdge("implementation", "checks"),
    buildEdge("checks", "verdict"),
    buildEdge("verdict", "finalize", "true"),
    buildEdge("finalize", "open-pr"),
    buildEdge("verdict", "retry", "false"),
    buildEdge("retry", "fix", "continue"),
    buildEdge("fix", "checks"),
  ];
  return { schemaVersion: 1, nodes, edges };
}

/**
 * A V3-shaped graph: a plan-approval hand-off split across two triggers. The
 * first chain plans and requests approval (send_plan_approval is a terminal
 * leaf); the second chain re-enters when the plan is approved and delivers.
 *   trigger_ticket_ai -> planning_agent -> send_plan_approval
 *   trigger_plan_approved -> implementation_agent -> open_pr -> update_ticket_status
 */
export function planApprovalDefinition(): WorkflowDefinition {
  const nodes: WorkflowDefinitionNode[] = [
    buildNode({ id: "trigger-ticket", type: "trigger_ticket_ai" }, 0),
    buildNode(
      {
        id: "planning",
        type: "planning_agent",
        inputs: {
          ticket: "trigger.ticket",
          comments: "trigger.comments",
          priorAnswers: "trigger.priorAnswers",
        },
      },
      1,
    ),
    buildNode(
      {
        id: "send-approval",
        type: "send_plan_approval",
        inputs: {
          plan: "steps.planning.output.plan",
        },
      },
      2,
    ),
    buildNode({ id: "trigger-approved", type: "trigger_plan_approved" }, 0, 1),
    buildNode(
      {
        id: "implementation",
        type: "implementation_agent",
        inputs: { ticket: "trigger.ticket", plan: "trigger.approvedPlan" },
      },
      1,
      1,
    ),
    buildNode({ id: "finalize", type: "finalize_workspace" }, 2, 1),
    buildNode(
      {
        id: "open-pr",
        type: "open_pr",
        inputs: { publicationAttemptId: "steps.finalize.output.publicationAttemptId" },
      },
      3,
      1,
    ),
    buildNode({ id: "status", type: "update_ticket_status", params: { target: "ai_review" } }, 4, 1),
  ];
  const edges: WorkflowDefinitionEdge[] = [
    buildEdge("trigger-ticket", "planning"),
    buildEdge("planning", "send-approval"),
    buildEdge("trigger-approved", "implementation"),
    buildEdge("implementation", "finalize"),
    buildEdge("finalize", "open-pr"),
    buildEdge("open-pr", "status"),
  ];
  return { schemaVersion: 1, nodes, edges };
}

/**
 * A V4-shaped graph: two PR triggers fan into one shared PR-fix pipeline. Both
 * trigger_pr_checks_failed and trigger_pr_review wire into a single
 * fetch_pr_context node (the validator allows unbounded in-degree), which then
 * runs a linear fix-and-comment chain.
 *   trigger_pr_checks_failed \
 *                             -> fetch_pr_context -> fix_agent
 *   trigger_pr_review        /      -> finalize_workspace -> post_pr_comment
 */
export function prReviewFixDefinition(): WorkflowDefinition {
  const nodes: WorkflowDefinitionNode[] = [
    buildNode({ id: "trigger-checks-failed", type: "trigger_pr_checks_failed" }, 0, 0),
    buildNode({ id: "trigger-review", type: "trigger_pr_review" }, 0, 1),
    buildNode({ id: "fetch-context", type: "fetch_pr_context" }, 1),
    buildNode({ id: "fix", type: "fix_agent" }, 2),
    buildNode({ id: "finalize", type: "finalize_workspace" }, 3),
    buildNode(
      { id: "comment", type: "post_pr_comment", params: { body: "Automated fix pushed. Please re-review." } },
      4,
    ),
  ];
  const edges: WorkflowDefinitionEdge[] = [
    buildEdge("trigger-checks-failed", "fetch-context"),
    buildEdge("trigger-review", "fetch-context"),
    buildEdge("fetch-context", "fix"),
    buildEdge("fix", "finalize"),
    buildEdge("finalize", "comment"),
  ];
  return { schemaVersion: 1, nodes, edges };
}
