import type { OrderedBlock } from "../workflow-definition/plan.js";

export interface LoadedWorkflowPlan {
  version: number | null;
  blocks: OrderedBlock[];
  reviewEnabled: boolean;
}

export async function loadWorkflowDefinition(): Promise<LoadedWorkflowPlan> {
  "use step";
  const { env } = await import("../../env.js");
  const { getDb } = await import("../db/client.js");
  const { getCurrentWorkflowDefinition } = await import("../workflow-definition/store.js");
  const { workflowDefinitionSchema, validateWorkflowGraph, describeWorkflowDefinitionIssues } =
    await import("../workflow-definition/schema.js");
  const { orderBlocks } = await import("../workflow-definition/plan.js");
  const { defaultOrderedBlocks } = await import("../workflow-definition/default.js");
  const { logger } = await import("../lib/logger.js");

  const buildDefault = (): LoadedWorkflowPlan => {
    const blocks = defaultOrderedBlocks({ includeReview: env.ENABLE_REVIEW_PHASE });
    return { version: null, blocks, reviewEnabled: blocks.some((b) => b.type === "review_agent") };
  };

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

  const blocks = orderBlocks(parsed.data);
  return {
    version: row.version,
    blocks,
    reviewEnabled: blocks.some((b) => b.type === "review_agent"),
  };
}
loadWorkflowDefinition.maxRetries = 0;
