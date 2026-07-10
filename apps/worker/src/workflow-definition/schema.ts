import { z } from "zod";
import type {
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionNode,
} from "@shared/contracts";

const nodeId = z.string().trim().min(1);
const coordinate = z.number().finite();

const baseNodeFields = {
  id: nodeId,
  name: z.string().optional(),
  x: coordinate,
  y: coordinate,
};

const emptyParams = z.object({}).strict();
const modelParams = z.object({ model: z.string().trim().max(200).optional() }).strict();

const triggerNode = z
  .object({ ...baseNodeFields, type: z.literal("trigger_ticket_ai"), params: emptyParams })
  .strict();

const planningNode = z
  .object({ ...baseNodeFields, type: z.literal("planning_agent"), params: modelParams })
  .strict();

const implementationNode = z
  .object({ ...baseNodeFields, type: z.literal("implementation_agent"), params: modelParams })
  .strict();

const reviewNode = z
  .object({ ...baseNodeFields, type: z.literal("review_agent"), params: modelParams })
  .strict();

const runPrePrChecksNode = z
  .object({
    ...baseNodeFields,
    type: z.literal("run_pre_pr_checks"),
    params: z
      .object({ maxFixCycles: z.number().int().min(0).max(5).optional() })
      .strict(),
  })
  .strict();

const openPrNode = z
  .object({ ...baseNodeFields, type: z.literal("open_pr"), params: emptyParams })
  .strict();

const updateTicketStatusNode = z
  .object({
    ...baseNodeFields,
    type: z.literal("update_ticket_status"),
    params: z.object({ target: z.enum(["ai_review", "backlog"]) }).strict(),
  })
  .strict();

const sendSlackMessageNode = z
  .object({
    ...baseNodeFields,
    type: z.literal("send_slack_message"),
    params: z.object({ message: z.string().trim().max(2000).optional() }).strict(),
  })
  .strict();

const nodeSchema = z.discriminatedUnion("type", [
  triggerNode,
  planningNode,
  implementationNode,
  reviewNode,
  runPrePrChecksNode,
  openPrNode,
  updateTicketStatusNode,
  sendSlackMessageNode,
]);

const edgeSchema = z
  .object({ from: z.string().trim().min(1), to: z.string().trim().min(1) })
  .strict();

export const workflowDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    nodes: z.array(nodeSchema),
    edges: z.array(edgeSchema),
  })
  .strict();

type AssertAssignable<T extends WorkflowDefinition> = T;
export type WorkflowDefinitionGuard = AssertAssignable<z.infer<typeof workflowDefinitionSchema>>;

export function describeWorkflowDefinitionIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "root"}: ${issue.message}`)
    .join("; ");
}

const REQUIRED_TYPES: WorkflowBlockType[] = [
  "planning_agent",
  "implementation_agent",
  "open_pr",
  "update_ticket_status",
];

export function validateWorkflowGraph(def: WorkflowDefinition): string[] {
  const issues: string[] = [];
  const { nodes, edges } = def;

  const nodeById = new Map<string, WorkflowDefinitionNode>();
  for (const node of nodes) {
    if (nodeById.has(node.id)) {
      issues.push(`Block id "${node.id}" is used more than once.`);
    }
    nodeById.set(node.id, node);
  }

  const triggers = nodes.filter((node) => node.type === "trigger_ticket_ai");
  if (triggers.length === 0) {
    issues.push("Workflow must contain exactly one trigger block (trigger_ticket_ai).");
  } else if (triggers.length > 1) {
    issues.push(`Workflow must contain exactly one trigger block, found ${triggers.length}.`);
  }
  const trigger = triggers.length === 1 ? triggers[0] : undefined;

  const outDegree = new Map<string, number>();
  const inDegree = new Map<string, number>();
  const seenEdges = new Set<string>();
  const nextOf = new Map<string, string>();

  for (const edge of edges) {
    if (!nodeById.has(edge.from)) {
      issues.push(`Connection references an unknown source block "${edge.from}".`);
    }
    if (!nodeById.has(edge.to)) {
      issues.push(`Connection references an unknown target block "${edge.to}".`);
    }
    if (edge.from === edge.to) {
      issues.push(`Block "${edge.from}" cannot connect to itself.`);
    }
    const key = `${edge.from}->${edge.to}`;
    if (seenEdges.has(key)) {
      issues.push(`Duplicate connection from "${edge.from}" to "${edge.to}".`);
    }
    seenEdges.add(key);

    outDegree.set(edge.from, (outDegree.get(edge.from) ?? 0) + 1);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    if (!nextOf.has(edge.from)) nextOf.set(edge.from, edge.to);
  }

  if (trigger && (inDegree.get(trigger.id) ?? 0) > 0) {
    issues.push(`The trigger block "${trigger.id}" must not have incoming connections.`);
  }

  for (const node of nodes) {
    if ((outDegree.get(node.id) ?? 0) > 1) {
      issues.push(`Block "${node.id}" has more than one outgoing connection.`);
    }
    if ((inDegree.get(node.id) ?? 0) > 1) {
      issues.push(`Block "${node.id}" has more than one incoming connection.`);
    }
  }

  const order = new Map<string, number>();
  if (trigger) {
    let current: string | undefined = trigger.id;
    let index = 0;
    while (current !== undefined && nodeById.has(current) && !order.has(current)) {
      order.set(current, index++);
      current = nextOf.get(current);
    }
    for (const node of nodes) {
      if (!order.has(node.id)) {
        issues.push(`Block "${node.id}" is not reachable from the trigger.`);
      }
    }
  }

  const typeCounts = new Map<WorkflowBlockType, number>();
  for (const node of nodes) typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1);
  for (const [type, count] of typeCounts) {
    if (type !== "trigger_ticket_ai" && count > 1) {
      issues.push(`Workflow must contain at most one ${type} block.`);
    }
  }

  for (const type of REQUIRED_TYPES) {
    if (!nodes.some((node) => node.type === type)) {
      issues.push(`Workflow is missing a required ${type} block.`);
    }
  }

  const positionOf = (type: WorkflowBlockType): number | undefined => {
    const node = nodes.find((candidate) => candidate.type === type);
    return node ? order.get(node.id) : undefined;
  };

  const planningPos = positionOf("planning_agent");
  const implementationPos = positionOf("implementation_agent");
  const reviewPos = positionOf("review_agent");
  const checksPos = positionOf("run_pre_pr_checks");
  const openPrPos = positionOf("open_pr");
  const slackPos = positionOf("send_slack_message");
  const statusPos = positionOf("update_ticket_status");

  if (planningPos !== undefined && implementationPos !== undefined && planningPos >= implementationPos) {
    issues.push("The planning_agent block must come before the implementation_agent block.");
  }
  if (reviewPos !== undefined && implementationPos !== undefined && reviewPos <= implementationPos) {
    issues.push("The review_agent block must come after the implementation_agent block.");
  }
  if (checksPos !== undefined && implementationPos !== undefined && checksPos <= implementationPos) {
    issues.push("The run_pre_pr_checks block must come after the implementation_agent block.");
  }
  if (openPrPos !== undefined && implementationPos !== undefined && openPrPos <= implementationPos) {
    issues.push("The open_pr block must come after the implementation_agent block.");
  }
  if (slackPos !== undefined && openPrPos !== undefined && slackPos <= openPrPos) {
    issues.push("The send_slack_message block must come after the open_pr block.");
  }
  if (statusPos !== undefined && openPrPos !== undefined && statusPos <= openPrPos) {
    issues.push("The update_ticket_status block must come after the open_pr block.");
  }

  return issues;
}
