import type {
  WorkflowExecutionBudgets,
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionV1,
  WorkflowDefinitionEdge,
  WorkflowDefinitionNode,
  WorkflowDefinitionV2,
} from "@shared/contracts";
import type { WorkflowDefinitionVersionRow } from "../workflow-definition/store.js";
import {
  BUILTIN_FALLBACK_DEFINITION_VERSION,
  type WorkflowDefinitionVersionPin,
} from "./agent-input.js";

export interface LoadedWorkflowPlan {
  schemaVersion: 1 | 2;
  /** Exact immutable definition selected for this run. V2 execution consumes
   * this graph directly so stable edge IDs, fan-out, and typed bindings are
   * never flattened into the legacy cursor model. */
  definition: WorkflowDefinition;
  version: number | null;
  /** Definition selected for dispatch; legacy unpinned fallback loads use null. */
  definitionId: number | null;
  nodes: WorkflowDefinitionNode[];
  edges: WorkflowDefinitionEdge[];
  reviewEnabled: boolean;
  budgets?: WorkflowExecutionBudgets;
}

interface ZodLikeError extends Error {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}

function isZodLikeError(error: unknown): error is ZodLikeError {
  return (
    error instanceof Error &&
    error.name === "ZodError" &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}

function describeZodLikeError(error: ZodLikeError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "root"}: ${issue.message}`)
    .join("; ");
}

/**
 * Preserve the authored graph for execution. Specialized agents provision or
 * reuse their own required workspace; modular consumers still require an
 * explicit Prepare workspace upstream and report that clearly at runtime.
 */
export function normalizeDefinitionForExecution(
  nodes: WorkflowDefinitionNode[],
  edges: WorkflowDefinitionEdge[],
): { nodes: WorkflowDefinitionNode[]; edges: WorkflowDefinitionEdge[] } {
  return { nodes, edges };
}

/**
 * Resolves the runnable plan for a trigger. With an explicit definitionId and
 * version the exact immutable snapshot is loaded. Legacy callers with an id but
 * no version resolve only that definition's deployed pointer. Without either,
 * the enabled trigger binding is used. The built-in graph is returned only for
 * the fresh-install ticket binding that has no stored version; missing or
 * invalid stored versions otherwise fail closed.
 */
export async function loadWorkflowDefinitionFor(
  triggerType: WorkflowBlockType,
  definitionId?: number,
  version?: WorkflowDefinitionVersionPin,
): Promise<LoadedWorkflowPlan | null> {
  "use step";
  const { env } = await import("../../env.js");
  const { getDb } = await import("../db/client.js");
  const {
    getDeployedWorkflowDefinitionVersion,
    getWorkflowDefinition,
    getWorkflowDefinitionVersion,
    getEnabledWorkflowDefinitionForTrigger,
  } = await import("../workflow-definition/store.js");
  const {
    workflowDefinitionV1Schema,
    workflowDefinitionV2Schema,
    upgradeStoredWorkflowDefinition,
    validateWorkflowDefinitionForDeployment,
    describeWorkflowDefinitionIssues,
  } = await import("../workflow-definition/schema.js");
  const { workflowBlockRegistryContextFromEnv } =
    await import("../workflow-definition/models.js");
  const { defaultWorkflowDefinition } = await import("../workflow-definition/default.js");
  const { logger } = await import("../lib/logger.js");

  const toLegacyRuntimeShape = (
    def: WorkflowDefinition,
  ): { nodes: WorkflowDefinitionNode[]; edges: WorkflowDefinitionEdge[] } => {
    if (def.schemaVersion === 1) {
      return normalizeDefinitionForExecution(def.nodes, def.edges);
    }
    return {
      nodes: def.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        ...(node.name ? { name: node.name } : {}),
        x: node.x,
        y: node.y,
        params: node.configuration,
        inputs: {},
      })) as unknown as WorkflowDefinitionNode[],
      edges: def.edges.map(({ from, to, fromPort }) => ({
        from,
        to,
        ...(fromPort ? { fromPort } : {}),
      })),
    };
  };

  const toPlan = (
    def: WorkflowDefinition,
    version: number | null,
    id: number | null,
  ): LoadedWorkflowPlan => {
    const normalized = toLegacyRuntimeShape(def);
    return {
      schemaVersion: def.schemaVersion,
      definition: def,
      version,
      definitionId: id,
      nodes: normalized.nodes,
      edges: normalized.edges,
      reviewEnabled: def.nodes.some((node) => node.type === "review_agent"),
      ...(def.budgets ? { budgets: def.budgets } : {}),
    };
  };

  const isTicket = triggerType === "trigger_ticket_ai";
  const buildDefault = (selectedDefinitionId: number | null = null): LoadedWorkflowPlan =>
    toPlan(
      defaultWorkflowDefinition({ includeReview: env.ENABLE_REVIEW_PHASE }),
      null,
      selectedDefinitionId,
    );

  // The fresh-install fallback has no immutable version row. Dispatch therefore
  // carries this explicit sentinel; honor it without consulting the row's later
  // deployed pointer, which may have changed after start().
  if (version === BUILTIN_FALLBACK_DEFINITION_VERSION) {
    if (!isTicket || definitionId === undefined) {
      logger.info({ triggerType, definitionId, version }, "workflow_definition_none");
      return null;
    }
    logger.info(
      { definitionId, version, reviewEnabled: env.ENABLE_REVIEW_PHASE },
      "workflow_definition_default",
    );
    return buildDefault(definitionId);
  }

  const db = getDb();
  let row: WorkflowDefinitionVersionRow | null;
  try {
    if (definitionId !== undefined) {
      row = version !== undefined
        ? await getWorkflowDefinitionVersion(db, definitionId, version)
        : await getDeployedWorkflowDefinitionVersion(db, definitionId);
      if (!row) {
        const definition =
          version === undefined ? await getWorkflowDefinition(db, definitionId) : null;
        if (
          isTicket &&
          definition?.enabled === true &&
          definition.deployedVersion === null &&
          definition.draftRevision === 0 &&
          definition.triggerTypes.includes("trigger_ticket_ai")
        ) {
          logger.info(
            { definitionId, version, reviewEnabled: env.ENABLE_REVIEW_PHASE },
            "workflow_definition_default",
          );
          return buildDefault();
        }
        logger.info({ triggerType, definitionId, version }, "workflow_definition_none");
        return null;
      }
    } else {
      const match = await getEnabledWorkflowDefinitionForTrigger(db, triggerType);
      if (!match || !match.current) {
        if (isTicket && match) {
          logger.info({ reviewEnabled: env.ENABLE_REVIEW_PHASE }, "workflow_definition_default");
          return buildDefault();
        }
        logger.info({ triggerType }, "workflow_definition_none");
        return null;
      }
      row = match.current;
    }
  } catch (error) {
    if (!isZodLikeError(error)) throw error;
    logger.error(
      { definitionId, version, triggerType, issues: describeZodLikeError(error) },
      "workflow_definition_invalid",
    );
    return null;
  }

  let upgraded: WorkflowDefinition;
  try {
    upgraded = upgradeStoredWorkflowDefinition(row.definition);
  } catch (error) {
    if (!isZodLikeError(error)) throw error;
    logger.error(
      {
        definitionId: row.definitionId,
        version: row.version,
        issues: describeZodLikeError(error),
      },
      "workflow_definition_invalid",
    );
    return null;
  }
  const parsed =
    upgraded.schemaVersion === 2
      ? workflowDefinitionV2Schema.safeParse(upgraded)
      : workflowDefinitionV1Schema.safeParse(upgraded);
  const graphIssues = parsed.success
    ? validateWorkflowDefinitionForDeployment(
        parsed.data,
        workflowBlockRegistryContextFromEnv(),
        parsed.data.schemaVersion === 1
          ? {
              allowLegacyCompatibility: true,
              checkEnvironmentAvailability: false,
            }
          : { checkEnvironmentAvailability: false },
      )
    : [];
  if (!parsed.success || graphIssues.length > 0) {
    const issues = parsed.success
      ? graphIssues.join("; ")
      : describeWorkflowDefinitionIssues(parsed.error);
    logger.error(
      { definitionId: row.definitionId, version: row.version, issues },
      "workflow_definition_invalid",
    );
    return null;
  }

  return toPlan(parsed.data as WorkflowDefinitionV1 | WorkflowDefinitionV2, row.version, row.definitionId);
}
loadWorkflowDefinitionFor.maxRetries = 0;

/** Ticket-trigger entrypoint. Always resolves a plan (built-in default when no
 *  valid stored definition), so agent.ts can treat the result as non-null. */
export async function loadWorkflowDefinition(): Promise<LoadedWorkflowPlan> {
  const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai");
  return plan as LoadedWorkflowPlan;
}
