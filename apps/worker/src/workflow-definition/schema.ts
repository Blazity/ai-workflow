import { z } from "zod";
import type {
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionNode,
} from "@shared/contracts";
import { BLOCK_TYPE_SPECS, isTriggerBlockType, wirablePorts } from "@shared/contracts";
import { parseCondition } from "@shared/conditions";

const nodeId = z.string().trim().min(1);
const coordinate = z.number().finite();

const baseNodeFields = {
  id: nodeId,
  name: z.string().optional(),
  x: coordinate,
  y: coordinate,
};

const emptyParams = z.object({}).strict();
const agentParams = z
  .object({
    model: z.string().trim().max(200).optional(),
    provider: z.enum(["claude", "codex"]).optional(),
  })
  .strict();

const triggerNode = z
  .object({ ...baseNodeFields, type: z.literal("trigger_ticket_ai"), params: emptyParams })
  .strict();

const planningNode = z
  .object({ ...baseNodeFields, type: z.literal("planning_agent"), params: agentParams })
  .strict();

const implementationNode = z
  .object({ ...baseNodeFields, type: z.literal("implementation_agent"), params: agentParams })
  .strict();

const reviewNode = z
  .object({ ...baseNodeFields, type: z.literal("review_agent"), params: agentParams })
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

const branchNode = z
  .object({
    ...baseNodeFields,
    type: z.literal("branch"),
    params: z.object({ condition: z.string().trim().min(1).max(1000) }).strict(),
  })
  .strict();

const loopNode = z
  .object({
    ...baseNodeFields,
    type: z.literal("loop"),
    params: z
      .object({
        maxAttempts: z.number().int().min(1).max(20),
        onExhaust: z.enum(["fail", "human", "continue"]),
      })
      .strict(),
  })
  .strict();

const terminateNode = z
  .object({
    ...baseNodeFields,
    type: z.literal("terminate"),
    params: z
      .object({
        terminalStatus: z.enum(["waiting_for_human", "failed", "skipped", "done"]),
        postComment: z.string().trim().min(1).max(2000).optional(),
      })
      .strict(),
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
  branchNode,
  loopNode,
  terminateNode,
]);

const edgeSchema = z
  .object({
    from: z.string().trim().min(1),
    to: z.string().trim().min(1),
    fromPort: z.string().trim().min(1).optional(),
  })
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

interface GraphEdge {
  from: string;
  to: string;
  port: string;
  fromType: WorkflowBlockType;
}

function findCycle(adjacency: Map<string, string[]>, nodeIds: string[]): string[] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of nodeIds) color.set(id, WHITE);

  for (const start of nodeIds) {
    if (color.get(start) !== WHITE) continue;
    const stack: { node: string; idx: number }[] = [{ node: start, idx: 0 }];
    color.set(start, GRAY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbors = adjacency.get(frame.node) ?? [];
      if (frame.idx < neighbors.length) {
        const next = neighbors[frame.idx];
        frame.idx += 1;
        const shade = color.get(next);
        if (shade === WHITE) {
          color.set(next, GRAY);
          stack.push({ node: next, idx: 0 });
        } else if (shade === GRAY) {
          const startIdx = stack.findIndex((entry) => entry.node === next);
          const path = stack.slice(startIdx).map((entry) => entry.node);
          path.push(next);
          return path;
        }
      } else {
        color.set(frame.node, BLACK);
        stack.pop();
      }
    }
  }
  return null;
}

function stronglyConnectedComponents(
  adjacency: Map<string, string[]>,
  nodeIds: string[],
): string[][] {
  let counter = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const componentStack: string[] = [];
  const result: string[][] = [];

  for (const start of nodeIds) {
    if (indices.has(start)) continue;
    const work: { node: string; idx: number }[] = [{ node: start, idx: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const node = frame.node;
      if (frame.idx === 0) {
        indices.set(node, counter);
        lowlink.set(node, counter);
        counter += 1;
        componentStack.push(node);
        onStack.add(node);
      }
      const neighbors = adjacency.get(node) ?? [];
      if (frame.idx < neighbors.length) {
        const next = neighbors[frame.idx];
        frame.idx += 1;
        if (!indices.has(next)) {
          work.push({ node: next, idx: 0 });
        } else if (onStack.has(next)) {
          lowlink.set(node, Math.min(lowlink.get(node)!, indices.get(next)!));
        }
      } else {
        if (lowlink.get(node) === indices.get(node)) {
          const component: string[] = [];
          for (;;) {
            const popped = componentStack.pop()!;
            onStack.delete(popped);
            component.push(popped);
            if (popped === node) break;
          }
          result.push(component);
        }
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1].node;
          lowlink.set(parent, Math.min(lowlink.get(parent)!, lowlink.get(node)!));
        }
      }
    }
  }
  return result;
}

function reachableFrom(seeds: string[], adjacency: Map<string, string[]>): Set<string> {
  const seen = new Set<string>(seeds);
  const queue = [...seeds];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    for (const next of adjacency.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

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

  const nodeIds = nodes.map((node) => node.id);
  const triggerNodes = nodes.filter((node) => isTriggerBlockType(node.type));

  if (triggerNodes.length === 0) {
    issues.push("Workflow must contain at least one trigger block.");
  }

  const triggerTypeCounts = new Map<WorkflowBlockType, number>();
  for (const node of triggerNodes) {
    triggerTypeCounts.set(node.type, (triggerTypeCounts.get(node.type) ?? 0) + 1);
  }
  for (const [type, count] of triggerTypeCounts) {
    if (count > 1) {
      issues.push(`Workflow contains more than one ${type} trigger block.`);
    }
  }

  const graphEdges: GraphEdge[] = [];
  for (const edge of edges) {
    const fromNode = nodeById.get(edge.from);
    const toNode = nodeById.get(edge.to);
    if (!fromNode) {
      issues.push(`Connection references an unknown source block "${edge.from}".`);
    }
    if (!toNode) {
      issues.push(`Connection references an unknown target block "${edge.to}".`);
    }
    if (edge.from === edge.to) {
      issues.push(`Block "${edge.from}" cannot connect to itself.`);
    }
    if (!fromNode || !toNode || edge.from === edge.to) continue;

    const spec = BLOCK_TYPE_SPECS[fromNode.type];
    if (spec.ports.length === 0) {
      issues.push(`Terminate block "${edge.from}" cannot have outgoing connections.`);
      continue;
    }
    const resolvedPort = edge.fromPort ?? spec.ports[0];
    if (!wirablePorts(fromNode.type).includes(resolvedPort)) {
      issues.push(
        `Connection from "${edge.from}" uses unknown port "${resolvedPort}" of block type ${fromNode.type}.`,
      );
    } else if (edge.fromPort === undefined && spec.ports.length > 1) {
      const label = fromNode.type === "loop" ? "loop" : "branch";
      issues.push(
        `Connection from ${label} "${edge.from}" must specify a port (${spec.ports.join("/")}).`,
      );
    }
    graphEdges.push({ from: edge.from, to: edge.to, port: resolvedPort, fromType: fromNode.type });
  }

  const exactSeen = new Set<string>();
  const portTargets = new Map<string, Set<string>>();
  for (const edge of graphEdges) {
    const portKey = `${edge.from} ${edge.port}`;
    const exactKey = `${portKey} ${edge.to}`;
    if (exactSeen.has(exactKey)) {
      issues.push(`Duplicate connection from "${edge.from}" to "${edge.to}".`);
      continue;
    }
    exactSeen.add(exactKey);
    const targets = portTargets.get(portKey);
    if (targets) {
      issues.push(`Block "${edge.from}" has multiple connections from port "${edge.port}".`);
      targets.add(edge.to);
    } else {
      portTargets.set(portKey, new Set([edge.to]));
    }
  }

  const incoming = new Map<string, number>();
  for (const edge of graphEdges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }
  for (const node of triggerNodes) {
    if ((incoming.get(node.id) ?? 0) > 0) {
      issues.push(`The trigger block "${node.id}" must not have incoming connections.`);
    }
  }

  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  const forwardNoLoopBack = new Map<string, string[]>();
  const portsOut = new Map<string, Set<string>>();
  for (const id of nodeIds) {
    forward.set(id, []);
    reverse.set(id, []);
    forwardNoLoopBack.set(id, []);
  }
  for (const edge of graphEdges) {
    forward.get(edge.from)!.push(edge.to);
    reverse.get(edge.to)!.push(edge.from);
    if (!(edge.fromType === "loop" && edge.port === "continue")) {
      forwardNoLoopBack.get(edge.from)!.push(edge.to);
    }
    const used = portsOut.get(edge.from) ?? new Set<string>();
    used.add(edge.port);
    portsOut.set(edge.from, used);
  }

  const reachable = reachableFrom(
    triggerNodes.map((node) => node.id),
    forward,
  );
  for (const node of nodes) {
    if (!isTriggerBlockType(node.type) && !reachable.has(node.id)) {
      issues.push(`Block "${node.id}" is not reachable from a trigger.`);
    }
  }

  for (const node of nodes) {
    if (node.type === "branch") {
      const used = portsOut.get(node.id) ?? new Set<string>();
      if (!used.has("true")) {
        issues.push(`Branch "${node.id}" must have its "true" port connected.`);
      }
      if (!used.has("false")) {
        issues.push(`Branch "${node.id}" must have its "false" port connected.`);
      }
    } else if (node.type === "loop") {
      const used = portsOut.get(node.id) ?? new Set<string>();
      if (!used.has("continue")) {
        issues.push(`Loop "${node.id}" must have its "continue" port connected.`);
      }
      if (node.params.onExhaust === "continue" && !used.has("exhausted")) {
        issues.push(
          `Loop "${node.id}" with onExhaust "continue" must have its "exhausted" port connected.`,
        );
      }
      const continueTargets = graphEdges
        .filter((edge) => edge.from === node.id && edge.port === "continue")
        .map((edge) => edge.to);
      if (continueTargets.length > 0) {
        const downstream = reachableFrom(continueTargets, forward);
        if (!downstream.has(node.id)) {
          issues.push(`Loop "${node.id}"'s continue port must lead back to it.`);
        }
      }
    }
  }

  const acyclicCycle = findCycle(forwardNoLoopBack, nodeIds);
  if (acyclicCycle) {
    const rendered = acyclicCycle.map((id) => `"${id}"`).join(" -> ");
    issues.push(`Blocks ${rendered} form a cycle that does not pass through a Loop block.`);
  }

  for (const component of stronglyConnectedComponents(forward, nodeIds)) {
    if (component.length <= 1) continue;
    const loopCount = component.filter((id) => nodeById.get(id)?.type === "loop").length;
    if (loopCount >= 2) {
      const rendered = component.map((id) => `"${id}"`).join(", ");
      issues.push(
        `Blocks [${rendered}] form a cycle region with ${loopCount} Loop blocks; each cycle region must contain exactly one.`,
      );
    }
  }

  for (const node of nodes) {
    if (node.type !== "branch") continue;
    const condition = node.params.condition;
    if (typeof condition !== "string") continue;
    const parsed = parseCondition(condition);
    if (!parsed.ok) {
      issues.push(`Branch "${node.id}" has an invalid condition: ${parsed.error}.`);
      continue;
    }
    const ancestors = reachableFrom(reverse.get(node.id) ?? [], reverse);
    for (const ref of parsed.refs) {
      if (!nodeById.has(ref) || !ancestors.has(ref)) {
        issues.push(
          `Branch "${node.id}" condition references block "${ref}" which does not run before it.`,
        );
      }
    }
  }

  return issues;
}
