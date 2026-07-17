import { isTriggerBlockType } from "@shared/contracts";
import type {
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionEdge,
  WorkflowDefinitionNode,
} from "@shared/contracts";
import type { WorkflowDefinitionVersionRow } from "../workflow-definition/store.js";
import {
  BUILTIN_FALLBACK_DEFINITION_VERSION,
  type WorkflowDefinitionVersionPin,
} from "./agent-input.js";

export interface LoadedWorkflowPlan {
  version: number | null;
  /** Definition selected for dispatch; legacy unpinned fallback loads use null. */
  definitionId: number | null;
  nodes: WorkflowDefinitionNode[];
  edges: WorkflowDefinitionEdge[];
  reviewEnabled: boolean;
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

// Block types whose executor requires ctx.sandboxId and fails with a
// "no workspace" error when it is missing. Kept in sync with the ctx.sandboxId
// guards in agent.ts (planning/implementation/review agents, run_pre_pr_checks,
// open_pr) and the block executors (generic-agent, fix-agent, run-checks,
// finalize-workspace). Auto-prepare exists to guarantee a workspace before any
// of these run.
const SANDBOX_DEPENDENT_BLOCK_TYPES = new Set<WorkflowBlockType>([
  "planning_agent",
  "implementation_agent",
  "review_agent",
  "fix_agent",
  "generic_agent",
  "run_pre_pr_checks",
  "run_checks",
  "finalize_workspace",
  "open_pr",
]);

/**
 * Per-trigger decision: does this trigger's chain need an auto-injected
 * prepare_workspace? It does when a sandbox-dependent block is reachable from
 * the trigger WITHOUT first passing through a prepare_workspace, i.e. a block
 * that needs a workspace could run before any workspace is provisioned. Existing
 * prepare_workspace nodes act as sinks in this search: everything behind one is
 * already covered, so we stop expanding there. The visited set keeps the walk
 * safe on loops/back-edges (each node is explored at most once).
 *
 * This is intentionally per-trigger: a multi-trigger graph where only one chain
 * carries an explicit prepare_workspace must still auto-prepare the other
 * chains, which a global "any prepare_workspace exists" check got wrong.
 */
function triggersNeedingAutoPrepare(
  nodes: WorkflowDefinitionNode[],
  edges: WorkflowDefinitionEdge[],
): Set<string> {
  const typeById = new Map(nodes.map((node) => [node.id, node.type] as const));
  const forward = new Map<string, string[]>();
  for (const edge of edges) {
    const list = forward.get(edge.from);
    if (list) list.push(edge.to);
    else forward.set(edge.from, [edge.to]);
  }

  const needing = new Set<string>();
  for (const node of nodes) {
    if (!isTriggerBlockType(node.type)) continue;
    const seen = new Set<string>([node.id]);
    const queue = [node.id];
    for (let head = 0; head < queue.length; head += 1) {
      const currentId = queue[head];
      const currentType = typeById.get(currentId);
      // A prepare_workspace covers everything downstream of it: stop, do not
      // expand past it.
      if (currentId !== node.id && currentType === "prepare_workspace") continue;
      if (
        currentId !== node.id &&
        currentType !== undefined &&
        SANDBOX_DEPENDENT_BLOCK_TYPES.has(currentType)
      ) {
        needing.add(node.id);
        break;
      }
      for (const next of forward.get(currentId) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
  }
  return needing;
}

/**
 * Execution-only normalization applied after validation. A virtual
 * prepare_workspace is spliced between a trigger and its successor for every
 * trigger whose chain would otherwise reach a sandbox-dependent block with no
 * workspace provisioned (see triggersNeedingAutoPrepare). Triggers that already
 * carry an explicit prepare_workspace ahead of their sandbox blocks are left
 * alone. Stored definitions are never modified; the virtual node exists only in
 * the loaded plan. Editor ids follow the "n<number>" scheme so "__prepare"
 * cannot collide, but the id is suffixed defensively until unique.
 */
export function normalizeDefinitionForExecution(
  nodes: WorkflowDefinitionNode[],
  edges: WorkflowDefinitionEdge[],
): { nodes: WorkflowDefinitionNode[]; edges: WorkflowDefinitionEdge[] } {
  const needing = triggersNeedingAutoPrepare(nodes, edges);
  if (needing.size === 0) {
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
    if (!needing.has(node.id)) continue;
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
      inputs: {},
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
 * Resolves the runnable plan for a trigger. With an explicit definitionId and
 * version the exact immutable snapshot is loaded. Legacy callers with an id but
 * no version resolve only that definition's deployed pointer. Without either,
 * the enabled trigger binding is used. The built-in graph is returned only for
 * the explicit fresh-install fallback row; missing or invalid stored versions
 * fail closed instead of silently switching execution paths.
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
    workflowDefinitionSchema,
    upgradeStoredWorkflowDefinition,
    validateWorkflowDefinitionForDeployment,
    describeWorkflowDefinitionIssues,
  } = await import("../workflow-definition/schema.js");
  const { workflowBlockRegistryContextFromEnv } =
    await import("../workflow-definition/models.js");
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
        if (isTicket && definition?.builtinFallback === true) {
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
        if (isTicket && match?.definition.builtinFallback === true) {
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
  const parsed = workflowDefinitionSchema.safeParse(upgraded);
  const graphIssues = parsed.success
    ? validateWorkflowDefinitionForDeployment(
        parsed.data,
        workflowBlockRegistryContextFromEnv(),
        {
          allowLegacyCompatibility: true,
          checkEnvironmentAvailability: false,
        },
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

  return toPlan(parsed.data, row.version, row.definitionId);
}
loadWorkflowDefinitionFor.maxRetries = 0;

/** Ticket-trigger entrypoint. Always resolves a plan (built-in default when no
 *  valid stored definition), so agent.ts can treat the result as non-null. */
export async function loadWorkflowDefinition(): Promise<LoadedWorkflowPlan> {
  const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai");
  return plan as LoadedWorkflowPlan;
}
