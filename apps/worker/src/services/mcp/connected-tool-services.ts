/** Production-only MCP composition. The injected factory remains test-only. */
import {
  findConnectedLiveRunClaimByRunId,
  findConnectedRunOutcomeByRunId,
} from "../../db/repositories/runs.js";
import {
  getConnectedResumeFailedClarificationForRun,
  getConnectedResumableClarificationForRun,
} from "../../db/repositories/clarification-hooks.js";
import {
  findConnectedPromptBySlug,
  getConnectedCurrentPromptVersion,
  getConnectedPrompt,
} from "../../db/repositories/prompts.js";
import { listConnectedSchedulesForDefinition } from "../../db/repositories/schedule-triggers.js";
import { getConnectedWebhookEndpointForNode } from "../../db/repositories/webhook-trigger-endpoints.js";
import { getConnectedWorkflowDefinition } from "../../db/repositories/definitions/connected.js";
import {
  listConnectedMcpPromptPage,
  listConnectedMcpTicketRunPage,
  listConnectedMcpWorkflowDefinitionPage,
  readConnectedMcpDeployedDefinitionVersions,
  readConnectedMcpPromptHeadVersions,
} from "../../db/repositories/mcp.js";
import { answerConnectedClarificationAndResume } from "../clarifications/index.js";
import { cancelConnectedRunForOperator } from "../run-lifecycle/index.js";
import {
  archiveConnectedWorkflowDefinition,
  createConnectedWorkflowDefinition,
  deployConnectedWorkflowDefinition,
  saveConnectedWorkflowDefinitionDraft,
  unarchiveConnectedWorkflowDefinition,
  updateConnectedWorkflowDefinition,
} from "../workflow-definitions/index.js";
import {
  dispatchConnectedManualWorkflow,
  preflightConnectedManualDispatch,
} from "../manual-dispatch/index.js";
import { requirePromptLibraryEditRole, saveConnectedPromptVersionWithPolicy, validatePromptBody } from "../prompts/index.js";
import {
  listHarnessProfilesForOrganization,
  publishHarnessProfileDraft,
  readHarnessProfileDetail,
  refreshHarnessProfileSkill,
} from "../harness/index.js";
import { maxConcurrentAgents } from "../settings/index.js";
import { createConnectedMcpGateServices } from "./gate-services.js";
import type { McpToolServices } from "./tool-services.js";
import { mapMcpTicketRunRows } from "./tool-queries.js";
import {
  connectedCostAgg,
  connectedListRuns,
  fetchConnectedRunDetailFromDb,
  getConnectedRunReplay,
  getConnectedRunReplayAttempt,
  getConnectedRunReplayAvailability,
} from "../run-lifecycle/index.js";
import {
  readConnectedCurrentWorkflowDefinitionVersion,
  readConnectedDeployedWorkflowDefinitionVersion,
  readConnectedWorkflowDefinitionVersion,
} from "../../engine/stored-definition-reads.js";
import type { SettingsSnapshot } from "@shared/contracts";

export function createConnectedMcpToolServices(
  settings: SettingsSnapshot,
): McpToolServices {
  return {
    ...createConnectedMcpGateServices(),
    async runExists(runId) {
      const [claim, outcome] = await Promise.all([
        findConnectedLiveRunClaimByRunId(runId),
        findConnectedRunOutcomeByRunId(runId),
      ]);
      return Boolean(claim || outcome);
    },
    getResumableClarificationForRun: getConnectedResumableClarificationForRun,
    getResumeFailedClarificationForRun: getConnectedResumeFailedClarificationForRun,
    answerClarificationAndResume: (input) =>
      answerConnectedClarificationAndResume({
        ...input,
        aiColumn: settings.COLUMN_AI,
        cancelSettings: settings,
      }),
    cancelRunForOperator: (runId, options) =>
      cancelConnectedRunForOperator(runId, { ...options, settings }),
    listWorkflowDefinitionPage: listConnectedMcpWorkflowDefinitionPage,
    readDeployedDefinitionVersions: readConnectedMcpDeployedDefinitionVersions,
    listPromptPage: listConnectedMcpPromptPage,
    readPromptHeadVersions: readConnectedMcpPromptHeadVersions,
    findPromptBySlug: findConnectedPromptBySlug,
    getPrompt: getConnectedPrompt,
    getCurrentPromptVersion: getConnectedCurrentPromptVersion,
    savePromptVersion: (input) => {
      requirePromptLibraryEditRole(
        input.actor.role as import("@shared/contracts").DashboardRole,
      );
      return saveConnectedPromptVersionWithPolicy({
        ...input,
        body: validatePromptBody(input.body),
      });
    },
    listHarnessProfiles: (organizationId) =>
      listHarnessProfilesForOrganization({ organizationId, includeArchived: false }),
    readHarnessProfileDetail,
    refreshHarnessProfileSkill,
    publishHarnessProfileDraft,
    fetchRunDetail: (runId, ticketLinks, secrets) =>
      fetchConnectedRunDetailFromDb({ runId, ticketLinks, secrets }),
    getRunReplay: getConnectedRunReplay,
    getRunReplayAvailability: getConnectedRunReplayAvailability,
    getRunReplayAttempt: getConnectedRunReplayAttempt,
    listRuns: connectedListRuns,
    costAgg: connectedCostAgg,
    listTicketRunPage: async (ticketKey, limit) =>
      mapMcpTicketRunRows(await listConnectedMcpTicketRunPage(ticketKey, limit)),
    listSchedulesForDefinition: listConnectedSchedulesForDefinition,
    getWebhookEndpointForNode: getConnectedWebhookEndpointForNode,
    createWorkflowDefinition: createConnectedWorkflowDefinition,
    saveWorkflowDefinitionDraft: saveConnectedWorkflowDefinitionDraft,
    deployWorkflowDefinition: deployConnectedWorkflowDefinition,
    updateWorkflowDefinition: updateConnectedWorkflowDefinition,
    // The very function the dashboard's DELETE reaches (definition-authoring.ts,
    // archiveWorkflowDefinitionById), so the two doors archive by one rule.
    archiveWorkflowDefinition: archiveConnectedWorkflowDefinition,
    unarchiveWorkflowDefinition: unarchiveConnectedWorkflowDefinition,
    getWorkflowDefinition: getConnectedWorkflowDefinition,
    getWorkflowDefinitionVersion: readConnectedWorkflowDefinitionVersion,
    getCurrentWorkflowDefinitionVersion: readConnectedCurrentWorkflowDefinitionVersion,
    getDeployedWorkflowDefinitionVersion: readConnectedDeployedWorkflowDefinitionVersion,
    preflightManualDispatch: (input) =>
      preflightConnectedManualDispatch({
        ...input,
        maxConcurrentAgents: maxConcurrentAgents(settings),
      }),
    dispatchManualWorkflow: (input) =>
      dispatchConnectedManualWorkflow({
        ...input,
        maxConcurrentAgents: maxConcurrentAgents(settings),
      }),
  };
}
