import { isTriggerBlockType } from "@shared/contracts";
import type {
  WorkflowBlockType,
  WorkflowDefinitionEdge,
  WorkflowDefinitionNode,
} from "@shared/contracts";
import type { WorkflowDefinitionVersionRow } from "../workflow-definition/store.js";

export interface LoadedWorkflowPlan {
  version: number | null;
  /** Definition the plan came from; null when it is the built-in fallback. */
  definitionId: number | null;
  nodes: WorkflowDefinitionNode[];
  edges: WorkflowDefinitionEdge[];
  reviewEnabled: boolean;
}

/**
 * Execution-only normalization applied after validation. Definitions without a
 * prepare_workspace block (V1 legacy graphs and the built-in default) get a
 * virtual one spliced between each trigger and its successor, so provisioning
 * always runs inside the graph. Stored definitions are never modified; the
 * virtual node exists only in the loaded plan. Editor ids follow the
 * "n<number>" scheme so "__prepare" cannot collide, but the id is suffixed
 * defensively until unique.
 */
export function normalizeDefinitionForExecution(
  nodes: WorkflowDefinitionNode[],
  edges: WorkflowDefinitionEdge[],
): { nodes: WorkflowDefinitionNode[]; edges: WorkflowDefinitionEdge[] } {
  if (nodes.some((node) => node.type === "prepare_workspace")) {
    return { nodes, edges };
  }

  const usedIds = new Set(nodes.map((node) => node.id));
  const claimVirtualId = (): string => {
    let candidate = "__prepare";
    while (usedIds.has(candidate)) candidate = `${candidate}_`;
    usedIds.add(candidate);
    return candidate;
  };

  const nextNodes: WorkflowDefinitionNode[] = [];
  let nextEdges = [...edges];

  for (const node of nodes) {
    nextNodes.push(node);
    if (!isTriggerBlockType(node.type)) continue;
    const outIndex = nextEdges.findIndex((edge) => edge.from === node.id);
    if (outIndex === -1) continue;
    const outEdge = nextEdges[outIndex];
    const virtualId = claimVirtualId();
    nextNodes.push({
      id: virtualId,
      type: "prepare_workspace",
      name: "Prepare workspace",
      x: node.x,
      y: node.y,
      params: {},
    });
    nextEdges = [
      ...nextEdges.slice(0, outIndex),
      { ...outEdge, to: virtualId },
      { from: virtualId, to: outEdge.to },
      ...nextEdges.slice(outIndex + 1),
    ];
  }

  return { nodes: nextNodes, edges: nextEdges };
}

/**
 * Resolves the runnable plan for a trigger. With an explicit definitionId the
 * pinned definition's head version is loaded; without one the enabled
 * definition for the trigger is used. When nothing valid resolves, the
 * trigger_ticket_ai trigger falls back to the built-in default (definitionId
 * null) — today's semantics — while any other trigger returns null.
 */
export async function loadWorkflowDefinitionFor(
  triggerType: WorkflowBlockType,
  definitionId?: number,
): Promise<LoadedWorkflowPlan | null> {
  "use step";
  const { env } = await import("../../env.js");
  const { getDb } = await import("../db/client.js");
  const { getCurrentWorkflowDefinitionVersion, getEnabledWorkflowDefinitionForTrigger } =
    await import("../workflow-definition/store.js");
  const { workflowDefinitionSchema, validateWorkflowGraph, describeWorkflowDefinitionIssues } =
    await import("../workflow-definition/schema.js");
  const { defaultWorkflowDefinition } = await import("../workflow-definition/default.js");
  const { logger } = await import("../lib/logger.js");

  const toPlan = (
    def: { nodes: WorkflowDefinitionNode[]; edges: WorkflowDefinitionEdge[] },
    version: number | null,
    id: number | null,
  ): LoadedWorkflowPlan => {
    const normalized = normalizeDefinitionForExecution(def.nodes, def.edges);
    return {
      version,
      definitionId: id,
      nodes: normalized.nodes,
      edges: normalized.edges,
      reviewEnabled: def.nodes.some((node) => node.type === "review_agent"),
    };
  };

  const isTicket = triggerType === "trigger_ticket_ai";
  const buildDefault = (): LoadedWorkflowPlan =>
    toPlan(defaultWorkflowDefinition({ includeReview: env.ENABLE_REVIEW_PHASE }), null, null);

  const db = getDb();
  let row: WorkflowDefinitionVersionRow | null;
  if (definitionId !== undefined) {
    row = await getCurrentWorkflowDefinitionVersion(db, definitionId);
    if (!row) {
      if (isTicket) {
        logger.info({ definitionId, reviewEnabled: env.ENABLE_REVIEW_PHASE }, "workflow_definition_default");
        return buildDefault();
      }
      logger.info({ triggerType, definitionId }, "workflow_definition_none");
      return null;
    }
  } else {
    const match = await getEnabledWorkflowDefinitionForTrigger(db, triggerType);
    if (!match || !match.current) {
      if (isTicket) {
        logger.info({ reviewEnabled: env.ENABLE_REVIEW_PHASE }, "workflow_definition_default");
        return buildDefault();
      }
      logger.info({ triggerType }, "workflow_definition_none");
      return null;
    }
    row = match.current;
  }

  const parsed = workflowDefinitionSchema.safeParse(row.definition);
  const graphIssues = parsed.success ? validateWorkflowGraph(parsed.data) : [];
  if (!parsed.success || graphIssues.length > 0) {
    const issues = parsed.success
      ? graphIssues.join("; ")
      : describeWorkflowDefinitionIssues(parsed.error);
    logger.error(
      { definitionId: row.definitionId, version: row.version, issues },
      "workflow_definition_invalid",
    );
    if (isTicket) return buildDefault();
    return null;
  }

  return toPlan(parsed.data, row.version, row.definitionId);
}
loadWorkflowDefinitionFor.maxRetries = 0;

/** Ticket-trigger entrypoint. Always resolves a plan (built-in default when no
 *  valid stored definition), so agent.ts can treat the result as non-null. */
export async function loadWorkflowDefinition(): Promise<LoadedWorkflowPlan> {
  const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai");
  return plan as LoadedWorkflowPlan;
}
