/**
 * Process-bound dependencies for definition policy.
 *
 * This lives above the repository layer so database repositories stay limited
 * to statements and row mapping.  The public functions deliberately expose
 * each use case, never a database handle.
 */
import {
  validateConnectedWorkflowDefinitionCandidateWithPromptAuthoring,
  validateConnectedWorkflowPromptAuthoringIssues,
} from "./prompt-authoring.js";
import { previewConnectedWorkflowPromptCandidate } from "./prompt-preview.js";
import {
  dispatchManualWorkflow,
  dispatchConnectedManualWorkflow,
  preflightConnectedManualDispatch,
  preflightManualDispatch,
} from "../manual-dispatch/index.js";
import { listConnectedTriggerRejectionCounters } from "../../db/repositories/trigger-rate-limits.js";
import { listConnectedWebhookTriggerRejections } from "../../db/repositories/webhook-trigger-deliveries.js";
import type { WorkflowDefinition } from "@shared/contracts";
import type { WorkflowValueAnalysis } from "@shared/workflow-graph";
import { connectedBlockContracts } from "./block-contracts.js";
import { trackerQueryTemplateFindings } from "./tracker-query-templates.js";

/**
 * The block data definition policy decides against.
 *
 * Declared here with policy's other connected dependencies rather than reached
 * for inside the operations, because resolving it reads the integration
 * connections: policy that called `connectedBlockContracts` directly took a
 * database dependency that none of its callers could see, and every test of an
 * operation needed a DATABASE_URL the moment this build shipped an integration.
 */
export function connectedDefinitionBlockContracts() {
  return connectedBlockContracts();
}

export function validateConnectedDefinitionPromptAuthoring(
  definition: WorkflowDefinition,
  analysis: WorkflowValueAnalysis,
) {
  return validateConnectedWorkflowPromptAuthoringIssues(definition, analysis);
}

/**
 * The editor's validation, with the tracker's word on the query templates:
 * a template `deployed` does not run and the tracker would not run is an
 * issue, and one `deployed` already runs is a notice that never counts
 * against `valid` (tracker-query-templates.ts).
 */
export async function validateConnectedDefinitionCandidate(
  candidate: unknown,
  baseline: { deployed: WorkflowDefinition | null },
) {
  const contracts = await connectedBlockContracts();
  const validation = await validateConnectedWorkflowDefinitionCandidateWithPromptAuthoring(
    candidate,
    contracts.resolveContract,
    contracts.blockParamsSchemas,
    contracts.configuredVcsProviders,
    contracts.analyzeValues,
  );
  if (!validation.parsed) return validation;
  const { refused, standing } = trackerQueryTemplateFindings(
    validation.parsed,
    contracts.trackerQueryRule,
    baseline.deployed,
  );
  const issues = [...validation.response.issues, ...refused];
  return {
    ...validation,
    response: {
      ...validation.response,
      valid: validation.response.valid && refused.length === 0,
      issues,
      ...(standing.length > 0 ? { notices: standing } : {}),
    },
  };
}

export function previewConnectedDefinitionPrompt(input: {
  candidate: unknown;
  blockId: string;
  organizationId?: string;
}) {
  return previewConnectedWorkflowPromptCandidate(input);
}

export function preflightConnectedDefinitionManual(
  input: Omit<Parameters<typeof preflightManualDispatch>[0], "db">,
) {
  return preflightConnectedManualDispatch(input);
}

export function dispatchConnectedDefinitionManual(
  input: Omit<Parameters<typeof dispatchManualWorkflow>[0], "db">,
) {
  return dispatchConnectedManualWorkflow(input);
}

export function readConnectedDefinitionTriggerRejections(
  key: { definitionId: string; nodeId: string },
  now: Date,
) {
  return listConnectedTriggerRejectionCounters({ ...key, day: now.toISOString().slice(0, 10) });
}

export function readConnectedDefinitionWebhookRejections(
  endpointId: string,
  now: Date,
) {
  return listConnectedWebhookTriggerRejections({
    endpointId,
    windowStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
  });
}
