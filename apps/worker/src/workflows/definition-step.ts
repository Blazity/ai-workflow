import type {
  WorkflowDefinitionEdge,
  WorkflowDefinitionNode,
} from "@shared/contracts";

export interface LoadedWorkflowPlan {
  version: number | null;
  nodes: WorkflowDefinitionNode[];
  edges: WorkflowDefinitionEdge[];
  reviewEnabled: boolean;
}

export async function loadWorkflowDefinition(): Promise<LoadedWorkflowPlan> {
  "use step";
  const { env } = await import("../../env.js");
  const { getDb } = await import("../db/client.js");
  const { getCurrentWorkflowDefinition } = await import("../workflow-definition/store.js");
  const { workflowDefinitionSchema, validateWorkflowGraph, describeWorkflowDefinitionIssues } =
    await import("../workflow-definition/schema.js");
  const { defaultWorkflowDefinition } = await import("../workflow-definition/default.js");
  const { logger } = await import("../lib/logger.js");

  const toPlan = (
    def: { nodes: WorkflowDefinitionNode[]; edges: WorkflowDefinitionEdge[] },
    version: number | null,
  ): LoadedWorkflowPlan => ({
    version,
    nodes: def.nodes,
    edges: def.edges,
    reviewEnabled: def.nodes.some((node) => node.type === "review_agent"),
  });

  const buildDefault = (): LoadedWorkflowPlan =>
    toPlan(defaultWorkflowDefinition({ includeReview: env.ENABLE_REVIEW_PHASE }), null);

  const row = await getCurrentWorkflowDefinition(getDb());
  if (!row) {
    logger.info({ reviewEnabled: env.ENABLE_REVIEW_PHASE }, "workflow_definition_default");
    return buildDefault();
  }

  const parsed = workflowDefinitionSchema.safeParse(row.definition);
  const graphIssues = parsed.success ? validateWorkflowGraph(parsed.data) : [];
  if (!parsed.success || graphIssues.length > 0) {
    const issues = parsed.success
      ? graphIssues.join("; ")
      : describeWorkflowDefinitionIssues(parsed.error);
    logger.error({ version: row.version, issues }, "workflow_definition_invalid");
    return buildDefault();
  }

  return toPlan(parsed.data, row.version);
}
loadWorkflowDefinition.maxRetries = 0;
