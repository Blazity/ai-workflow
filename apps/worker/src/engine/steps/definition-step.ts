import type {
  IntegrationConnectionPin,
  SettingsSnapshot,
  WorkflowExecutionBudgets,
  WorkflowRepositoryScope,
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionEdge,
  WorkflowDefinitionNode,
} from "@shared/contracts";
import { RETIRED_SCHEMA_MESSAGE } from "@shared/contracts";
// Static because both symbols are used only inside the step body, so they land
// in the steps bundle rather than in workflow scope, and because the package is
// pure zod and contracts: it pulls in no node built-in wherever it lands. The
// deployment validator below stays dynamic, because its graph reaches the block
// registry.
import { describeWorkflowDefinitionIssues, parse } from "@shared/workflow-graph";
import type { WorkflowDefinitionVersionRow } from "../../db/repositories/definitions.js";
// Type only, so it erases before the Workflow DevKit ever sees this file.
import type { DeploymentIntegrations } from "../definition/integration-availability.js";
import type { RunIntegrationBlocker } from "../definition/integration-run.js";
import {
  BUILTIN_FALLBACK_DEFINITION_VERSION,
  type WorkflowDefinitionVersionPin,
} from "../agent-input.js";

export interface LoadedWorkflowPlan {
  /** Exact immutable definition selected for this run. Execution consumes this
   * graph directly so stable edge IDs, fan-out, and typed bindings are never
   * flattened into a cursor model. */
  definition: WorkflowDefinition;
  version: number | null;
  /** Definition selected for dispatch; legacy unpinned fallback loads use null. */
  definitionId: number | null;
  nodes: WorkflowDefinitionNode[];
  edges: WorkflowDefinitionEdge[];
  reviewEnabled: boolean;
  budgets?: WorkflowExecutionBudgets;
  /** Repositories pinned to the definition, inherited by every run it dispatches. */
  repositoryScope?: WorkflowRepositoryScope;
  /**
   * The connection each integration this graph uses had when the run started.
   *
   * Recorded here, inside the step that loaded the definition, so the Workflow
   * DevKit replays the pin from its own result rather than reading a database
   * that has moved on. A run suspended across a deploy therefore comes back
   * holding what it started with and learns at its next use that the
   * connection changed, instead of quietly adopting the new one.
   *
   * Absent on a plan replayed from before this shipped, which is what makes
   * this additive for every run in flight.
   */
  integrationPins?: readonly IntegrationConnectionPin[];
  /** Set when an integration the graph uses cannot run at all right now. The
   *  run fails before any work, naming it, and records the reason as a code. */
  integrationBlocker?: RunIntegrationBlocker;
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
 * Resolves the runnable plan for a trigger. With an explicit definitionId and
 * version the exact immutable snapshot is loaded. Legacy callers with an id but
 * no version resolve only that definition's deployed pointer. Without either,
 * the enabled trigger binding is used. The built-in graph is returned only for
 * the fresh-install ticket binding that has no stored version; missing or
 * invalid stored versions otherwise fail closed.
 */
export async function loadWorkflowDefinitionFor(
  /** The settings this run started with, loaded once by the run-start step.
   *  The built-in fallback graph and every block contract below are shaped
   *  from these, so a run that spans an operator saving the Settings page
   *  still resolves one definition. */
  settings: SettingsSnapshot,
  triggerType: WorkflowBlockType,
  definitionId?: number,
  version?: WorkflowDefinitionVersionPin,
): Promise<LoadedWorkflowPlan | null> {
  "use step";
  const {
    getConnectedDeployedWorkflowDefinitionVersion,
    getConnectedWorkflowDefinition,
    getConnectedWorkflowDefinitionVersion,
  } = await import("../../db/repositories/definitions/connected.js");
  const { getConnectedEnabledWorkflowDefinitionForTrigger } =
    await import("../definition-trigger-routing.js");
  const { validateWorkflowDefinitionForRunLoad } =
    await import("../definition/deployment-validation.js");
  const { createWorkflowBlockContractResolver } =
    await import("../definition/block-contract-resolver.js");
  const { workflowBlockRegistryContext } =
    await import("../definition/block-contract-environment.js");
  const { blockParamsSchemasFor } = await import("../definition/block-params-schemas.js");
  const { deploymentIntegrations, NO_INTEGRATIONS } = await import(
    "../definition/integration-availability.js"
  );
  const { builtinCapabilitiesOfDeployment } = await import(
    "../definition/block-contract-environment.js"
  );
  const { integrationPinsFor, runIntegrationBlocker } = await import(
    "../definition/integration-run.js"
  );
  const { integrationManifests } = await import("@integrations/registry");
  const { readIntegrationStates } = await import("../../services/integrations/runtime.js");
  const { defaultWorkflowDefinitionV2 } = await import("../definition/default.js");
  const { logger } = await import("../../infra/logger.js");

  const toRuntimeShape = (
    def: WorkflowDefinition,
  ): { nodes: WorkflowDefinitionNode[]; edges: WorkflowDefinitionEdge[] } => {
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

  /**
   * What each integration this graph uses looks like right now.
   *
   * Read here, inside the step, and frozen into the plan: the run then carries
   * the connection it started with, and the Workflow DevKit replays it from
   * this step's own result rather than reading the database again.
   */
  const integrationsNow = async () => {
    // Nothing to read on a build that ships no integration, which is every
    // deployment until the first one lands.
    if (integrationManifests.length === 0) return NO_INTEGRATIONS;
    return deploymentIntegrations({
      manifests: integrationManifests,
      states: await readIntegrationStates(),
      builtinCapabilities: builtinCapabilitiesOfDeployment(),
    });
  };

  const toPlan = async (
    def: WorkflowDefinition,
    planVersion: number | null,
    id: number | null,
    /** The read the caller already made, so one load sees one deployment. */
    known?: DeploymentIntegrations,
  ): Promise<LoadedWorkflowPlan> => {
    const normalized = toRuntimeShape(def);
    const integrations = known ?? (await integrationsNow());
    const blocker = runIntegrationBlocker(def.nodes, integrations);
    return {
      definition: def,
      version: planVersion,
      definitionId: id,
      nodes: normalized.nodes,
      edges: normalized.edges,
      reviewEnabled: def.nodes.some((node) => node.type === "review_agent"),
      integrationPins: integrationPinsFor(def.nodes, integrations),
      ...(blocker ? { integrationBlocker: blocker } : {}),
      ...(def.budgets ? { budgets: def.budgets } : {}),
      ...(def.repositoryScope ? { repositoryScope: def.repositoryScope } : {}),
    };
  };

  const isTicket = triggerType === "trigger_ticket_ai";
  const buildDefault = (
    selectedDefinitionId: number | null = null,
  ): Promise<LoadedWorkflowPlan> =>
    toPlan(
      defaultWorkflowDefinitionV2({
        includeReview: false,
        includeLeakReview: false,
      }),
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
      { definitionId, version, reviewEnabled: false },
      "workflow_definition_default",
    );
    return await buildDefault(definitionId);
  }

  let row: WorkflowDefinitionVersionRow | null;
  try {
    if (definitionId !== undefined) {
      row = version !== undefined
        ? await getConnectedWorkflowDefinitionVersion(definitionId, version)
        : await getConnectedDeployedWorkflowDefinitionVersion(definitionId);
      if (!row) {
        const definition =
          version === undefined ? await getConnectedWorkflowDefinition(definitionId) : null;
        if (
          isTicket &&
          definition?.enabled === true &&
          definition.deployedVersion === null &&
          definition.draftRevision === 0 &&
          definition.triggerTypes.includes("trigger_ticket_ai")
        ) {
          logger.info(
            { definitionId, version, reviewEnabled: false },
            "workflow_definition_default",
          );
          return await buildDefault();
        }
        logger.info({ triggerType, definitionId, version }, "workflow_definition_none");
        return null;
      }
    } else {
      const match = await getConnectedEnabledWorkflowDefinitionForTrigger(triggerType);
      if (!match || !match.current) {
        if (isTicket && match) {
          logger.info({ reviewEnabled: false }, "workflow_definition_default");
          return await buildDefault();
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

  if (row.schema !== "v2") {
    // A stored row this build cannot run. Throwing hands the run to the
    // transparent-failure path, which records the reason and comments it on the
    // ticket; returning null would skip the run without saying why.
    logger.error(
      { definitionId: row.definitionId, version: row.version },
      "workflow_definition_schema_retired",
    );
    throw new Error(RETIRED_SCHEMA_MESSAGE);
  }
  const parsed = parse(row.definition);
  // The same integrations the plan pins below. Without them every integration
  // block resolves to the contract for a block nothing provides, the walk
  // refuses the graph, and a run using a perfectly healthy integration would
  // die here as an invalid definition: no failure reason, no ticket comment.
  const integrations = await integrationsNow();
  const registryContext = workflowBlockRegistryContext(undefined, integrations);
  const graphIssues = parsed.definition
    ? validateWorkflowDefinitionForRunLoad(
        parsed.definition,
        createWorkflowBlockContractResolver(registryContext),
        blockParamsSchemasFor(integrations),
        registryContext.vcsProviders,
      )
    : [];
  if (parsed.definition === null || graphIssues.length > 0) {
    const issues =
      parsed.definition === null
        ? describeWorkflowDefinitionIssues(parsed.error)
        : graphIssues.join("; ");
    logger.error(
      { definitionId: row.definitionId, version: row.version, issues },
      "workflow_definition_invalid",
    );
    return null;
  }

  return await toPlan(parsed.definition, row.version, row.definitionId, integrations);
}
loadWorkflowDefinitionFor.maxRetries = 0;
