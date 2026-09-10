import type { RunDetail, RunStep } from "@shared/contracts";
import type { IssueTrackerAdapter } from "../../adapters/issue-tracker/types.js";
import type { RunRegistryAdapter } from "../../adapters/run-registry/types.js";
import { getDb, type Db } from "../../db/client.js";
import { fetchRunDetailFromDb } from "../../db/queries/run-detail-read.js";
import {
  costAgg,
  findLiveRunClaimByRunId,
  findRunOutcomeByRunId,
  listRuns,
  type TimeWindow,
} from "../../db/queries/runs-read.js";
import {
  getResumableClarificationForRun,
  getResumeFailedClarificationForRun,
  type HookClarificationRow,
} from "../../clarifications/hook-store.js";
import {
  findPromptBySlug,
  getCurrentPromptVersion,
  getPrompt,
  savePromptVersion,
} from "../../prompt-library/store.js";
import {
  getRunReplay,
  getRunReplayAttempt,
  getRunReplayAvailability,
} from "../../run-observability/store.js";
import { listSchedulesForDefinition } from "../../schedule-trigger/schedule-store.js";
import { getWebhookEndpointForNode } from "../../webhook-trigger/endpoint-store.js";
import {
  createWorkflowDefinition,
  deployWorkflowDefinition,
  getCurrentWorkflowDefinitionVersion,
  getDeployedWorkflowDefinitionVersion,
  getWorkflowDefinition,
  getWorkflowDefinitionVersion,
  saveWorkflowDefinitionDraft,
  updateWorkflowDefinition,
} from "../../workflow-definition/store.js";
import {
  answerClarificationAndResume,
  type AnswerClarificationOutcome,
} from "../clarifications/index.js";
import {
  dispatchManualWorkflow,
  preflightManualDispatch,
} from "../manual-dispatch/index.js";
import { cancelRunForOperator } from "../run-lifecycle/index.js";
import { maxConcurrentAgents } from "../settings/index.js";
import { createMcpGateServices, type McpGateServices } from "./gate-services.js";
import {
  deployedDefinitionVersionsQuery,
  promptHeadVersionsQuery,
  promptPageQuery,
  ticketRunPageQuery,
  workflowDefinitionPageQuery,
  type TicketRunRow,
} from "./tool-queries.js";

export type { TicketRunRow };

/** The time window a run listing or cost aggregation is taken over. */
export type McpStatsWindow = TimeWindow;

/**
 * Every database-backed operation an MCP tool may perform, as a closed list.
 *
 * Stage 6c replaced the raw `Db` handle that used to sit in
 * `McpToolDependencies`. A tool decides what to publish and how to render it; it
 * never decides how to reach storage, so what it can reach is enumerated here
 * rather than left open. Each member is the use case one tool already performed,
 * with the handle removed and nothing else changed, so the queries that were
 * deliberately hand-written for a page (rather than reusing an unbounded list
 * helper) stay hand-written and keep their LIMIT.
 */
export interface McpToolServices extends McpGateServices {
  // --- run control -------------------------------------------------------
  /** Whether any trace of this run exists: a live claim, or a recorded outcome.
   *  Two lookups because a freshly bound run exists in active_runs before its
   *  workflow_runs row is written. */
  runExists(runId: string): Promise<boolean>;
  getResumableClarificationForRun(runId: string): Promise<HookClarificationRow | null>;
  getResumeFailedClarificationForRun(runId: string): Promise<HookClarificationRow | null>;
  answerClarificationAndResume(input: {
    row: HookClarificationRow;
    rawAnswer: string;
    actor: { id: string; label: string };
    issueTracker: IssueTrackerAdapter;
  }): Promise<AnswerClarificationOutcome>;
  cancelRunForOperator(
    runId: string,
    options: {
      actorLabel: string;
      runRegistry: RunRegistryAdapter;
      issueTracker: IssueTrackerAdapter;
    },
  ): ReturnType<typeof cancelRunForOperator>;

  // --- discovery ---------------------------------------------------------
  /** One page of live workflow definitions, ordered by id, with one extra row so
   *  truncation is detectable without a second count query. */
  listWorkflowDefinitionPage(limit: number): Promise<
    {
      id: number;
      name: string;
      enabled: boolean;
      deployedVersion: number | null;
    }[]
  >;
  /** The stored definition of each named (definitionId, version) pair, in one
   *  query rather than one per definition. */
  readDeployedDefinitionVersions(
    pairs: readonly { definitionId: number; version: number }[],
  ): Promise<{ definitionId: number; definition: unknown }[]>;
  /** One page of live prompts, ordered by id, with the same extra row. */
  listPromptPage(limit: number): Promise<{ id: number; slug: string; name: string }[]>;
  /** The head version number of each named prompt. */
  readPromptHeadVersions(
    promptIds: readonly number[],
  ): Promise<{ promptId: number; currentVersion: number | null }[]>;
  findPromptBySlug(slug: string): ReturnType<typeof findPromptBySlug>;
  getPrompt(promptId: number): ReturnType<typeof getPrompt>;
  getCurrentPromptVersion(promptId: number): ReturnType<typeof getCurrentPromptVersion>;
  savePromptVersion(
    input: Parameters<typeof savePromptVersion>[1],
  ): ReturnType<typeof savePromptVersion>;

  // --- run reads ---------------------------------------------------------
  fetchRunDetail(
    runId: string,
    jiraBaseUrl: string,
  ): Promise<{ run: RunDetail; steps: RunStep[] } | null>;
  getRunReplay(input: {
    runId: string;
    organizationId: string;
    limit: number;
    cursor: string | null;
    now: Date;
  }): ReturnType<typeof getRunReplay>;
  getRunReplayAvailability(input: {
    runId: string;
    organizationId: string;
    now: Date;
  }): ReturnType<typeof getRunReplayAvailability>;
  getRunReplayAttempt(input: {
    runId: string;
    organizationId: string;
    attemptId: number;
    now: Date;
  }): ReturnType<typeof getRunReplayAttempt>;
  listRuns(input: {
    window: TimeWindow;
    q: string | null;
    now: Date;
    jiraBaseUrl: string;
    limit: number;
  }): ReturnType<typeof listRuns>;
  costAgg(input: { window: TimeWindow; now: Date }): ReturnType<typeof costAgg>;
  /** One page of a ticket's runs, newest first, LIMIT in the query so the page
   *  cannot claim a wider run count than it returns. */
  listTicketRunPage(ticketKey: string, limit: number): Promise<TicketRunRow[]>;

  // --- workflow authoring ------------------------------------------------
  listSchedulesForDefinition(
    definitionId: number,
  ): ReturnType<typeof listSchedulesForDefinition>;
  getWebhookEndpointForNode(
    definitionId: number,
    nodeId: string,
  ): ReturnType<typeof getWebhookEndpointForNode>;
  createWorkflowDefinition(
    input: Parameters<typeof createWorkflowDefinition>[1],
  ): ReturnType<typeof createWorkflowDefinition>;
  saveWorkflowDefinitionDraft(
    input: Parameters<typeof saveWorkflowDefinitionDraft>[1],
  ): ReturnType<typeof saveWorkflowDefinitionDraft>;
  deployWorkflowDefinition(
    input: Parameters<typeof deployWorkflowDefinition>[1],
  ): ReturnType<typeof deployWorkflowDefinition>;
  updateWorkflowDefinition(
    input: Parameters<typeof updateWorkflowDefinition>[1],
  ): ReturnType<typeof updateWorkflowDefinition>;
  getWorkflowDefinition(
    definitionId: number,
  ): ReturnType<typeof getWorkflowDefinition>;
  getWorkflowDefinitionVersion(
    definitionId: number,
    version: number,
  ): ReturnType<typeof getWorkflowDefinitionVersion>;
  getCurrentWorkflowDefinitionVersion(
    definitionId: number,
  ): ReturnType<typeof getCurrentWorkflowDefinitionVersion>;
  getDeployedWorkflowDefinitionVersion(
    definitionId: number,
  ): ReturnType<typeof getDeployedWorkflowDefinitionVersion>;

  // --- manual dispatch ---------------------------------------------------
  preflightManualDispatch(
    input: Omit<
      Parameters<typeof preflightManualDispatch>[0],
      "db" | "maxConcurrentAgents"
    >,
  ): ReturnType<typeof preflightManualDispatch>;
  dispatchManualWorkflow(
    input: Omit<Parameters<typeof dispatchManualWorkflow>[0], "db" | "maxConcurrentAgents">,
  ): ReturnType<typeof dispatchManualWorkflow>;
}

/**
 * Bind every operation to one database handle.
 *
 * Production passes nothing and gets the request's handle; the worker's tests
 * pass their pglite handle, which is why the parameter exists at all.
 */
export function createMcpToolServices(db: Db = getDb()): McpToolServices {
  return {
    ...createMcpGateServices(db),

    async runExists(runId) {
      const [claim, outcome] = await Promise.all([
        findLiveRunClaimByRunId(db, runId),
        findRunOutcomeByRunId(db, runId),
      ]);
      return Boolean(claim || outcome);
    },
    getResumableClarificationForRun: (runId) =>
      getResumableClarificationForRun(db, runId),
    getResumeFailedClarificationForRun: (runId) =>
      getResumeFailedClarificationForRun(db, runId),
    answerClarificationAndResume: (input) =>
      answerClarificationAndResume({ db, ...input }),
    cancelRunForOperator: (runId, options) =>
      cancelRunForOperator(db, runId, options),

    listWorkflowDefinitionPage: workflowDefinitionPageQuery(db),
    readDeployedDefinitionVersions: deployedDefinitionVersionsQuery(db),
    listPromptPage: promptPageQuery(db),
    readPromptHeadVersions: promptHeadVersionsQuery(db),
    findPromptBySlug: (slug) => findPromptBySlug(db, slug),
    getPrompt: (promptId) => getPrompt(db, promptId),
    getCurrentPromptVersion: (promptId) => getCurrentPromptVersion(db, promptId),
    savePromptVersion: (input) => savePromptVersion(db, input),

    fetchRunDetail: (runId, jiraBaseUrl) =>
      fetchRunDetailFromDb({ db, runId, jiraBaseUrl }),
    getRunReplay: (input) => getRunReplay({ db, ...input }),
    getRunReplayAvailability: (input) => getRunReplayAvailability({ db, ...input }),
    getRunReplayAttempt: (input) => getRunReplayAttempt({ db, ...input }),
    listRuns: (input) => listRuns({ db, ...input }),
    costAgg: (input) => costAgg({ db, ...input }),
    listTicketRunPage: ticketRunPageQuery(db),

    listSchedulesForDefinition: (definitionId) =>
      listSchedulesForDefinition(db, definitionId),
    getWebhookEndpointForNode: (definitionId, nodeId) =>
      getWebhookEndpointForNode(db, definitionId, nodeId),
    createWorkflowDefinition: (input) => createWorkflowDefinition(db, input),
    saveWorkflowDefinitionDraft: (input) => saveWorkflowDefinitionDraft(db, input),
    deployWorkflowDefinition: (input) => deployWorkflowDefinition(db, input),
    updateWorkflowDefinition: (input) => updateWorkflowDefinition(db, input),
    getWorkflowDefinition: (definitionId) => getWorkflowDefinition(db, definitionId),
    getWorkflowDefinitionVersion: (definitionId, version) =>
      getWorkflowDefinitionVersion(db, definitionId, version),
    getCurrentWorkflowDefinitionVersion: (definitionId) =>
      getCurrentWorkflowDefinitionVersion(db, definitionId),
    getDeployedWorkflowDefinitionVersion: (definitionId) =>
      getDeployedWorkflowDefinitionVersion(db, definitionId),

    preflightManualDispatch: (input) =>
      preflightManualDispatch({
        db,
        ...input,
        maxConcurrentAgents: maxConcurrentAgents(),
      }),
    dispatchManualWorkflow: (input) =>
      dispatchManualWorkflow({
        db,
        ...input,
        maxConcurrentAgents: maxConcurrentAgents(),
      }),
  };
}
