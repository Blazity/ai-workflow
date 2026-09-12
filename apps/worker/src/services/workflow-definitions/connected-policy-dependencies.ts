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

export function validateConnectedDefinitionPromptAuthoring(
  definition: WorkflowDefinition,
  analysis: WorkflowValueAnalysis,
) {
  return validateConnectedWorkflowPromptAuthoringIssues(definition, analysis);
}

export async function validateConnectedDefinitionCandidate(candidate: unknown) {
  const contracts = await connectedBlockContracts();
  return validateConnectedWorkflowDefinitionCandidateWithPromptAuthoring(
    candidate,
    contracts.resolveContract,
    contracts.blockParamsSchemas,
    contracts.configuredVcsProviders,
    contracts.analyzeValues,
  );
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
