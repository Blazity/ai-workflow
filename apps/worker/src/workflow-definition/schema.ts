import { z } from "zod";
import type {
  TicketStatusTarget,
  WorkflowBindingSource,
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionNode,
} from "@shared/contracts";
import { BLOCK_TYPE_SPECS, isTriggerBlockType, wirablePorts } from "@shared/contracts";
import { parseCondition } from "@shared/conditions";
import { paramsSchema as prepareWorkspaceParams } from "../workflows/blocks/prepare-workspace.js";
import { paramsSchema as finalizeWorkspaceParams } from "../workflows/blocks/finalize-workspace.js";
import { paramsSchema as fixAgentParams } from "../workflows/blocks/fix-agent.js";
import { paramsSchema as genericAgentParams } from "../workflows/blocks/generic-agent.js";
import { paramsSchema as callLlmParams } from "../workflows/blocks/call-llm.js";
import { paramsSchema as fetchPrContextParams } from "../workflows/blocks/fetch-pr-context.js";
import { paramsSchema as runChecksParams } from "../workflows/blocks/run-checks.js";
import { paramsSchema as postTicketCommentParams } from "../workflows/blocks/post-ticket-comment.js";
import { paramsSchema as postPrCommentParams } from "../workflows/blocks/post-pr-comment.js";
import { paramsSchema as humanQuestionParams } from "../workflows/blocks/human-question.js";
import { paramsSchema as arthurInjectionCheckParams } from "../workflows/blocks/arthur-injection-check.js";
import { paramsSchema as sendPlanApprovalParams } from "../workflows/blocks/send-plan-approval.js";
import {
  buildWorkflowBindingGraphContext,
  isSafeWorkflowInputName,
  isWorkflowBindingSource,
  validateWorkflowBindings,
  type WorkflowBindingGraphContext,
} from "./bindings.js";
import {
  resolveWorkflowBlockContract,
  workflowBlockDefinitionIssue,
  type WorkflowBlockRegistryContext,
} from "./block-registry.js";

const nodeId = z.string().trim().min(1);
const coordinate = z.number().finite();
const bindingSource = z.custom<WorkflowBindingSource>(
  (source) => typeof source === "string" && isWorkflowBindingSource(source),
  { message: "Binding source must start with trigger.*, steps.<nodeId>.output.*, or run.*." },
);
const bindingInputName = z.custom<string>(
  (name) => typeof name === "string" && isSafeWorkflowInputName(name),
  { message: "Input name contains an empty or unsafe path segment." },
);

const baseNodeFields = {
  id: nodeId,
  name: z.string().optional(),
  x: coordinate,
  y: coordinate,
  inputs: z.record(bindingInputName, bindingSource).default({}),
};

const emptyParams = z.object({}).strict();
const agentParams = z
  .object({
    model: z.string().trim().max(200).regex(/^[A-Za-z0-9._:\/-]+$/).optional(),
    provider: z.enum(["claude", "codex"]).optional(),
  })
  .strict();

const vcsProviders = z.enum(["github", "gitlab"]);
const reviewStates = z.enum(["changes_requested", "commented"]);

// Mirrors TicketStatusTarget: the Record makes a domain value added or dropped a
// build error here, so the accepted targets cannot drift from the ones the
// editor offers (buildWorkflowEditorOptions) or the runtime honours
// (resolveTicketMoveTarget).
const ticketStatusTargets = {
  ai_review: "ai_review",
  backlog: "backlog",
} as const satisfies Record<TicketStatusTarget, TicketStatusTarget>;

const triggerNode = z
  .object({ ...baseNodeFields, type: z.literal("trigger_ticket_ai"), params: emptyParams })
  .strict();

const triggerPlanApprovedNode = z
  .object({ ...baseNodeFields, type: z.literal("trigger_plan_approved"), params: emptyParams })
  .strict();

const triggerPrCreatedNode = z
  .object({
    ...baseNodeFields,
    type: z.literal("trigger_pr_created"),
    params: z
      .object({
        providers: z.array(vcsProviders).default(["github", "gitlab"]),
        onlyWorkflowOwned: z.boolean().default(true),
      })
      .strict(),
  })
  .strict();

const triggerPrChecksFailedNode = z
  .object({
    ...baseNodeFields,
    type: z.literal("trigger_pr_checks_failed"),
    params: z
      .object({ providers: z.array(vcsProviders).default(["github", "gitlab"]) })
      .strict(),
  })
  .strict();

// on: which submitted review states may trigger a run. Defaults to
// ["changes_requested"] only — a "commented" review carries an untrusted body
// that fix_agent would feed to a full-permission agent, so operators must opt in
// to "commented" explicitly.
const triggerPrReviewNode = z
  .object({
    ...baseNodeFields,
    type: z.literal("trigger_pr_review"),
    params: z
      .object({
        providers: z.array(vcsProviders).default(["github"]),
        on: z.array(reviewStates).default(["changes_requested"]),
      })
      .strict(),
  })
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
    params: z.object({ target: z.nativeEnum(ticketStatusTargets) }).strict(),
  })
  .strict();

const prepareWorkspaceNode = z
  .object({ ...baseNodeFields, type: z.literal("prepare_workspace"), params: prepareWorkspaceParams })
  .strict();

const finalizeWorkspaceNode = z
  .object({ ...baseNodeFields, type: z.literal("finalize_workspace"), params: finalizeWorkspaceParams })
  .strict();

const fixAgentNode = z
  .object({ ...baseNodeFields, type: z.literal("fix_agent"), params: fixAgentParams })
  .strict();

const genericAgentNode = z
  .object({ ...baseNodeFields, type: z.literal("generic_agent"), params: genericAgentParams })
  .strict();

const callLlmNode = z
  .object({ ...baseNodeFields, type: z.literal("call_llm"), params: callLlmParams })
  .strict();

const fetchPrContextNode = z
  .object({ ...baseNodeFields, type: z.literal("fetch_pr_context"), params: fetchPrContextParams })
  .strict();

const runChecksNode = z
  .object({ ...baseNodeFields, type: z.literal("run_checks"), params: runChecksParams })
  .strict();

const postTicketCommentNode = z
  .object({ ...baseNodeFields, type: z.literal("post_ticket_comment"), params: postTicketCommentParams })
  .strict();

const postPrCommentNode = z
  .object({ ...baseNodeFields, type: z.literal("post_pr_comment"), params: postPrCommentParams })
  .strict();

const humanQuestionNode = z
  .object({ ...baseNodeFields, type: z.literal("human_question"), params: humanQuestionParams })
  .strict();

const arthurInjectionCheckNode = z
  .object({
    ...baseNodeFields,
    type: z.literal("arthur_injection_check"),
    params: arthurInjectionCheckParams,
  })
  .strict();

const sendSlackMessageNode = z
  .object({
    ...baseNodeFields,
    type: z.literal("send_slack_message"),
    params: z.object({ message: z.string().trim().max(2000).optional() }).strict(),
  })
  .strict();

const sendPlanApprovalNode = z
  .object({ ...baseNodeFields, type: z.literal("send_plan_approval"), params: sendPlanApprovalParams })
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
  triggerPlanApprovedNode,
  triggerPrCreatedNode,
  triggerPrChecksFailedNode,
  triggerPrReviewNode,
  planningNode,
  implementationNode,
  reviewNode,
  fixAgentNode,
  genericAgentNode,
  prepareWorkspaceNode,
  finalizeWorkspaceNode,
  runPrePrChecksNode,
  runChecksNode,
  callLlmNode,
  fetchPrContextNode,
  openPrNode,
  updateTicketStatusNode,
  postTicketCommentNode,
  postPrCommentNode,
  sendSlackMessageNode,
  sendPlanApprovalNode,
  humanQuestionNode,
  arthurInjectionCheckNode,
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

// Sized far above any hand-drawn workflow (the built-in default is 8 blocks/7
// connections) but low enough to bound validateWorkflowGraph, whose dominator
// fixpoint is O(N^2*E) and copies the node universe per node.
const MAX_NODES = 200;
const MAX_EDGES = 400;
const executionBudgetsSchema = z
  .object({
    maxDurationMs: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    maxCostUsd: z.number().finite().positive().optional(),
  })
  .strict();

export const workflowDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    budgets: executionBudgetsSchema.optional(),
    nodes: z.array(nodeSchema).max(MAX_NODES, `Workflow cannot have more than ${MAX_NODES} blocks.`),
    edges: z
      .array(edgeSchema)
      .max(MAX_EDGES, `Workflow cannot have more than ${MAX_EDGES} connections.`),
  })
  .strict();

// Ordinary version reads deliberately do not apply current block-param or
// graph rules: operators must be able to open and repair an old invalid graph.
// This narrower schema validates only the stable persisted envelope and
// performs deterministic shape upgrades such as adding node.inputs.
const storedWorkflowParamValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);
type StoredWorkflowBlockType = WorkflowBlockType | "arthur_trace";

const storedWorkflowBlockType = z.custom<StoredWorkflowBlockType>(
  (type) =>
    type === "arthur_trace" ||
    (typeof type === "string" && Object.prototype.hasOwnProperty.call(BLOCK_TYPE_SPECS, type)),
  { message: "Unknown workflow block type." },
);
const storedWorkflowNode = z
  .object({
    id: nodeId,
    type: storedWorkflowBlockType,
    name: z.string().optional(),
    x: coordinate,
    y: coordinate,
    params: z.record(storedWorkflowParamValue),
    inputs: z.record(bindingInputName, bindingSource).optional(),
  })
  .passthrough();
const storedWorkflowDefinition = z
  .object({
    schemaVersion: z.literal(1),
    budgets: executionBudgetsSchema.optional(),
    nodes: z.array(storedWorkflowNode),
    edges: z.array(edgeSchema),
  })
  .passthrough();

export function upgradeStoredWorkflowDefinition(raw: unknown): WorkflowDefinition {
  const parsed = storedWorkflowDefinition.parse(raw);
  const storedNodeById = new Map(parsed.nodes.map((node) => [node.id, node]));
  const retiredNodeIds = new Set(
    parsed.nodes.filter((node) => node.type === "arthur_trace").map((node) => node.id),
  );

  const resolveNormalTargets = (nodeId: string, seen: Set<string>): string[] => {
    if (!retiredNodeIds.has(nodeId)) return [nodeId];
    if (seen.has(nodeId)) return [];

    const nextSeen = new Set(seen).add(nodeId);
    return parsed.edges
      .filter(
        (edge) =>
          edge.from === nodeId && (edge.fromPort === undefined || edge.fromPort === "out"),
      )
      .flatMap((edge) => resolveNormalTargets(edge.to, nextSeen));
  };

  const edges = parsed.edges.flatMap((edge) => {
    if (retiredNodeIds.has(edge.from)) return [];
    return resolveNormalTargets(edge.to, new Set()).map((to) => ({
      from: edge.from,
      to,
      ...(edge.fromPort === undefined ? {} : { fromPort: edge.fromPort }),
    }));
  });

  const nodes: WorkflowDefinitionNode[] = [];
  const requiredChecksByFinalize = new Map<string, string[]>();
  for (const node of parsed.nodes) {
    if (node.type === "arthur_trace") continue;
    const params = { ...node.params };
    const inputs = { ...(node.inputs ?? {}) };
    if (node.type === "generic_agent" && params.workspaceMode === undefined) {
      params.workspaceMode = "read_write";
    }
    if (node.type === "send_plan_approval") {
      const sourceId = params.planFromStep;
      if (typeof sourceId === "string" && sourceId.length > 0) {
        inputs.plan ??= `steps.${sourceId}.output.plan`;
      }
      delete params.planFromStep;
    }
    if (node.type === "arthur_injection_check") {
      const sourceId = params.contentFromStep;
      if (typeof sourceId === "string" && sourceId.length > 0 && inputs.content === undefined) {
        const sourceNode = storedNodeById.get(sourceId);
        const sourceType = sourceNode?.type;
        const declaredOutputSchema = sourceNode?.params.outputSchema;
        const usesDeclaredOutputSchema =
          (sourceType === "generic_agent" || sourceType === "call_llm") &&
          typeof declaredOutputSchema === "string" &&
          declaredOutputSchema.trim().length > 0;
        const field =
          sourceType === "planning_agent"
            ? "plan"
            : sourceType === "generic_agent" && !usesDeclaredOutputSchema
              ? "body"
              : sourceType === "call_llm" && !usesDeclaredOutputSchema
                ? "output"
                : null;
        if (field) {
          inputs.content = `steps.${sourceId}.output.${field}`;
        } else {
          params.legacyContentFromStep = sourceId;
        }
      }
      delete params.contentFromStep;
    }
    if (node.type === "finalize_workspace") {
      const requiredChecks = params.requiredChecks;
      if (Array.isArray(requiredChecks)) {
        requiredChecksByFinalize.set(node.id, requiredChecks);
      }
      delete params.requiredChecks;
    }
    nodes.push({
      id: node.id,
      type: node.type,
      ...(node.name === undefined ? {} : { name: node.name }),
      x: node.x,
      y: node.y,
      params,
      inputs,
    });
  }

  const intermediate: WorkflowDefinition = { schemaVersion: 1, nodes, edges };
  const graphContext = buildWorkflowBindingGraphContext(intermediate);
  const upgradedNodes = nodes.map((node): WorkflowDefinitionNode => {
    if (node.type !== "finalize_workspace") return node;

    const params = { ...node.params };
    const inputs = { ...node.inputs };
    const legacy = new Set<string>();
    if (Array.isArray(params.legacyRequiredChecks)) {
      for (const id of params.legacyRequiredChecks) legacy.add(id);
    }
    delete params.legacyRequiredChecks;

    for (const sourceId of requiredChecksByFinalize.get(node.id) ?? []) {
      const inputName = `checks.${sourceId}`;
      const source = `steps.${sourceId}.output.status`;
      const canBind =
        sourceId !== node.id &&
        graphContext.nodeById.has(sourceId) &&
        (graphContext.dominators.get(node.id)?.has(sourceId) ?? false) &&
        isSafeWorkflowInputName(inputName) &&
        isWorkflowBindingSource(source) &&
        (inputs[inputName] === undefined || inputs[inputName] === source);
      if (canBind) {
        inputs[inputName] ??= source;
      } else {
        legacy.add(sourceId);
      }
    }

    if (legacy.size > 0) params.legacyRequiredChecks = [...legacy];
    return { ...node, params, inputs };
  });

  return {
    schemaVersion: 1,
    ...(parsed.budgets === undefined ? {} : { budgets: parsed.budgets }),
    nodes: upgradedNodes,
    edges,
  };
}

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

/**
 * Compute the dominator set of every node reachable from a trigger.
 *
 * D dominates N when every path from the entry to N passes through D. The
 * multiple triggers are modelled as a single virtual entry (each trigger's only
 * predecessor), so a block dominates N only if it lies on every path from *any*
 * trigger to N. Loop back-edges are left in `predecessors` (they arrive via the
 * reverse adjacency); the classic iterative fixpoint below handles the resulting
 * cycles, so a block inside a loop dominates a later node only when it is
 * unavoidable regardless of how many times the loop iterates.
 *
 * Returns a map from node id to its dominators (always including the node
 * itself). Nodes unreachable from a trigger are omitted.
 */
function computeDominators(
  entries: string[],
  reachable: Set<string>,
  predecessors: Map<string, string[]>,
): Map<string, Set<string>> {
  const entrySet = new Set(entries.filter((id) => reachable.has(id)));
  const universe = [...reachable];
  const dominators = new Map<string, Set<string>>();
  for (const id of universe) {
    // An entry is dominated only by itself; every other node starts with the
    // full universe and is narrowed by intersecting its predecessors' sets.
    dominators.set(id, entrySet.has(id) ? new Set([id]) : new Set(universe));
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const id of universe) {
      if (entrySet.has(id)) continue;
      const preds = (predecessors.get(id) ?? []).filter((pred) => reachable.has(pred));
      let next: Set<string> | null = null;
      for (const pred of preds) {
        const predDom = dominators.get(pred)!;
        if (next === null) {
          next = new Set(predDom);
        } else {
          for (const candidate of [...next]) {
            if (!predDom.has(candidate)) next.delete(candidate);
          }
        }
      }
      if (next === null) next = new Set();
      next.add(id);
      const current = dominators.get(id)!;
      if (next.size !== current.size || [...next].some((entry) => !current.has(entry))) {
        dominators.set(id, next);
        changed = true;
      }
    }
  }

  return dominators;
}

export function validateWorkflowGraph(
  def: WorkflowDefinition,
  bindingGraphContext?: WorkflowBindingGraphContext,
): string[] {
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
      issues.push(`Terminal block "${edge.from}" (${fromNode.type}) cannot have outgoing connections.`);
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
    const portKey = `${edge.from}\0${edge.port}`;
    const exactKey = `${portKey}\0${edge.to}`;
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

  const dominators =
    bindingGraphContext?.dominators ??
    computeDominators(
      triggerNodes.map((node) => node.id),
      reachable,
      reverse,
    );
  for (const node of nodes) {
    if (node.type !== "branch") continue;
    const condition = node.params.condition;
    if (typeof condition !== "string") continue;
    const parsed = parseCondition(condition);
    if (!parsed.ok) {
      issues.push(`Branch "${node.id}" has an invalid condition: ${parsed.error}.`);
      continue;
    }
    // A referenced block must dominate this branch: every path from a trigger to
    // the branch has to pass through it, otherwise a run could reach the branch
    // without the block having produced an output. "An ancestor on some path" is
    // not enough (that was the bug) -- it has to be a strict dominator.
    const nodeDominators = dominators.get(node.id);
    for (const ref of parsed.refs) {
      const dominates =
        ref !== node.id && nodeById.has(ref) && (nodeDominators?.has(ref) ?? false);
      if (!dominates) {
        issues.push(
          `Branch "${node.id}" condition references block "${ref}" which does not run before it.`,
        );
      }
    }
  }

  return issues;
}

/** Validation required before a definition may become executable. Draft saves
 * use `workflowDefinitionSchema` plus `validateWorkflowGraph` only so an
 * operator can keep editing a structurally sound but incomplete graph. */
export function validateWorkflowDefinitionForDeployment(
  def: WorkflowDefinition,
  registryContext: WorkflowBlockRegistryContext,
  options: {
    allowLegacyCompatibility?: boolean;
    checkEnvironmentAvailability?: boolean;
  } = {},
): string[] {
  const graphContext = buildWorkflowBindingGraphContext(def);
  const issues = [
    ...validateWorkflowGraph(def, graphContext),
    ...validateWorkflowBindings(def, registryContext, graphContext),
  ];
  for (const node of def.nodes) {
    if (
      !options.allowLegacyCompatibility &&
      node.type === "finalize_workspace" &&
      Array.isArray(node.params.legacyRequiredChecks)
    ) {
      issues.push(
        `Block "${node.id}" must replace legacy requiredChecks "${node.params.legacyRequiredChecks.join(", ")}" with explicit checks.* status input bindings before deployment.`,
      );
    }
    if (
      !options.allowLegacyCompatibility &&
      node.type === "arthur_injection_check" &&
      typeof node.params.legacyContentFromStep === "string"
    ) {
      issues.push(
        `Block "${node.id}" must replace legacy contentFromStep "${node.params.legacyContentFromStep}" with an explicit string input binding before deployment.`,
      );
    }
    const definitionIssue = workflowBlockDefinitionIssue(node.type, node.params);
    if (definitionIssue) {
      issues.push(
        `Block "${node.id}" (${node.type}) is unavailable: ${definitionIssue}`,
      );
    } else if (options.checkEnvironmentAvailability !== false) {
      const availability = resolveWorkflowBlockContract(
        node.type,
        node.params,
        registryContext,
      ).availability;
      if (!availability.available) {
        issues.push(
          `Block "${node.id}" (${node.type}) is unavailable: ${availability.unavailableReason}`,
        );
      }
    }
  }
  return [...new Set(issues)];
}
