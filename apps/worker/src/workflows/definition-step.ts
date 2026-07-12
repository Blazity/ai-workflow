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
  ): LoadedWorkflowPlan => ({
    version,
    definitionId: id,
    nodes: def.nodes,
    edges: def.edges,
    reviewEnabled: def.nodes.some((node) => node.type === "review_agent"),
  });

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
