/* eslint-disable require-unicode-regexp */
import { createHook, getWorkflowMetadata } from "workflow";
import { branchForTicket } from "./support/workflow-naming.js";
import { ticketRunUrl, hasDashboardLinkComment } from "./support/dashboard-links.js";
// Pure and contracts-only, like the two support modules above it, so the
// workflow isolate stays free of Node builtins.
import { isRepositoryCatalogRefusal } from "./support/repository-access.js";
import { computeUsageTotals } from "../sandbox/usage.js";
import type { AgentOutput, PhaseUsage, ResearchResult, ReviewOutput } from "../sandbox/agents/types.js";
import type { AgentKind } from "../sandbox/agents/index.js";
import type { IssueTrackerMoveTarget } from "../adapters/issue-tracker/types.js";
import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";
import { selectWorkItems } from "./helpers/review-ledger.js";
import { executionError, WORKSPACE_GATE_NOT_RECORDED_PREFIX, type StepsRecord } from "../workflow-definition/interpreter.js";
import { formatExecutionErrorForUser, WorkflowExecutionError } from "./helpers/execution-error.js";
import { executeV2Graph, V2_PRODUCTION_SCHEDULER_BOUNDS, type V2BlockExecutor, type V2SchedulerCheckpoint, type V2SchedulerHooks } from "../workflow-definition/v2-scheduler.js";
import { buildV2ReplayGraphSnapshot, createV2RunObservationHooks, type V2RunObservationHooks } from "../run-observability/runtime-hooks.js";
import { configuredReplaySecrets } from "../run-observability/configured-secrets.js";
import { emitAgentInvocationObservations, emitRepositoryWorkflowObservation, emitTimedOutAgentInvocationObservations } from "../run-observability/agent-observations.js";
import { persistWorkspaceMemoryStep } from "./steps/memory-steps.js";
import { distillRepoMemoryStep, loadRepoMemorySourcesStep } from "./steps/repo-memory-steps.js";
import { resolveAgentInput } from "./helpers/resolve-agent-input.js";
import { assembleReviewChangeSetAddition, pullRequestChangeSetTarget } from "./steps/review-change-set.js";
import { sanitizeReplayAttemptOutcome, sanitizeReplayGraphSnapshot, sanitizeReplayValue } from "../run-observability/sanitizer.js";
import { safeReplayAgentProtocolMetadata, safeWorkflowExecutionLogEvent } from "../run-observability/safe-execution-log.js";
import { executeTransform, type V2BindingResolutionContext } from "@shared/workflow-graph";
import { JSON_SCHEMA_SUPPORT } from "./definition/json-schema-support.js";
import type { BlockExecutionContext, BlockExecutionResult, BlockExecutor } from "../workflow-definition/interpreter.js";
import { resolveBlockAgent, resolveRunDefaultKind } from "../workflow-definition/resolve-agent.js";
import { resolveTicketMoveTarget } from "./helpers/ticket-move-target.js";
import { runKindForAgentWorkflowInput, type AgentWorkflowInput } from "./agent-input.js";
import { moveTicketStep } from "./steps/ticket-transition-step.js";
import { agentArtifactPhase, agentProtocolExecutionError as agentProtocolBlockError, blockBudgetObserver, buildV2AgentArtifactKeys, recordBlockPhaseUsage, type EngineCtx } from "./blocks/support/types.js";
import { VARIABLE_PARAM_KEYS } from "@shared/prompts";
import { compatibilityPromptSourceForV2Node, compileEffectivePrompt, effectivePromptProfileSource } from "./helpers/effective-prompt.js";
import { loadInvocationRepositoryInstructionSources } from "./steps/repository-instructions.js";
import { transformRegexEvaluator } from "./helpers/transform-regex-evaluator.js";
import { publicationPrsForTelemetry } from "./helpers/publication-prs-for-telemetry.js";
import { withAnalysisDelivery, withAnalysisPublication } from "./support/run-analysis-report.js";
import {
  invalidateWorkspaceGate,
  recordSuccessfulWorkspaceGate,
  serializeWorkspaceGate,
} from "./steps/workspace-gate.js";
import { resolveReviewFeedbackInput } from "./helpers/review-feedback.js";
import { workspaceRepositoryAccess, type WorkspaceManifest, type WorkspaceRepositoryInput } from "../sandbox/repo-workspace.js";
import { ensureWorkspace, maybePromoteGenericAgentWorkspace, maybePromoteTicketWorkspaceWrites, promoteWorkspaceWrites, requiredAgentsForDefinition, researchDeclaredNoWritesGuard } from "./blocks/prepare-workspace/execute.js";
import { prepareHarnessAgentInvocationStep } from "./blocks/agent-sandbox.js";
import { recoverScriptDriftFromSteps } from "./blocks/finalize-workspace/execute.js";
import { resolveCallLlmTarget } from "./blocks/call-llm/execute.js";
import { pollPhaseUntilDone } from "./blocks/poll-phase.js";
import { loadPrePrCheckConfigStep, recoverChecksCeilingFromSteps, runPrePrChecksWithFixes } from "./blocks/pre-pr-checks.js";
import { type PrePrCheckRunResult } from "./steps/pre-pr-checks-runner.js";
import { isRepositoryScriptsRefusal, repositoryScriptFailureEntry, repositoryScriptsOutput, repositoryScriptsStatus } from "./blocks/support/repository-scripts-output.js";
import { RunBudgetError, addElapsed, checksCeilingErrorDetail, createRunBudgetState, isChecksCeilingExceededError, isDurationAbortError, isV2InvocationCancelledError, observeRunBudget, propagateInvocationInterruption, recordBudgetUsage, runBudgetFailureFromError, type RunBudgetAttribution, type RunBudgetLimits, type RunBudgetFailure, type RunBudgetObservation, type RunBudgetState } from "./helpers/run-budget.js";
import { isRunControlError } from "./helpers/run-control-error.js";
import { BLOCK_EXECUTORS } from "./blocks/executors.generated.js";
import { createWorkflowExecutionErrorState, isTriggerBlockType, RETIRED_SCHEMA_MESSAGE } from "@shared/contracts";
import type { BlockOutput, BlockRunState, RunPullRequest, RunAnalysisReport, TransformConfiguration, WorkflowBlockType, WorkflowDefinitionNode, WorkflowDefinitionV2, WorkflowExecutionErrorState, WorkflowParamValue, HarnessRunManifestRecord } from "@shared/contracts";
import type { CostProvider, CostProviderKind, TokenPrice } from "@shared/costs";
import type { ResolvedHarnessRuntime } from "../sandbox/harness-runtime.js";
import { buildResearchAnalysisReportBestEffort, loadApprovedPlanAnalysisReportBestEffort, logPhaseFailure, logWorkflowExecutionErrorStep, markRunFailedOnSelfMoveStep, markRunSucceededOnSelfMoveStep, markTicketFailed, notifyTicket, notifyTicketBestEffort, postFailureReasonCommentStep, postPrLinksComment, postRunAnalysisCommentStep, postTicketComment, recordRunAnalysisCommentFailureBestEffort, recordRunAnalysisReportBestEffort, recordRunFailureReasonStep, safeRunAnalysisDeliveryError, safeRunAnalysisReportError } from "./steps/ticket-analysis.js";
import { applyHumanRepositoryExpansion, attachResearchRepositoriesStep, checksCeilingOption, createHarnessInvocationBudget, ensurePlanningAgentSandboxForBlock, fetchAttachments, fetchModelPriceStep, listFreshRepositoryCatalogStep, parseAgentOutputStep, parseRepositoryDiscoveryStep, parseResearchStep, parseReviewStep, planPhaseStep, readRunBudgetClockStep, resolveHumanRepositoryExpansionStep, setCommitGuardStep, writeAndStartPhase, writeAttachments } from "./steps/phase.js";
import { loadClarificationHistoryStep, logClarificationHistoryFailure, parkForClarificationStep, postClarificationQuestionsCommentStep, postPickupCommentStep, reconcileClarificationsOnPickup, resolveAgentKindOverride, resolveHarnessRuntimesStep, validateReviewSafePlanStep } from "./steps/clarification.js";
import { prePrChecksFailureMessage } from "./steps/repository-failure.js";
import { type SanitizedReplayObservation, captureV2RunObservationStartStep, closeTerminalPrChecksStep, finishV2RunObservationAttemptStep, flushV2RunObservationsStep, markV2RunObservationUnavailableStep, persistRunTelemetryBestEffort, recordBlockStatusesStep, resolveClarificationDecisionObservation, startV2RunObservationAttemptStep, updateV2RunObservationWaitingStep } from "./steps/telemetry.js";
import { resolveAgentTicketInput, resolveImplementationPlanInput, selectEntryTriggerNode, triggerOutputWithTicketContext, triggerTypeFor } from "./helpers/trigger-input.js";
import { appendClarificationRound, blockRunStateSummary, buildImplementationAgentSuccessOutput, buildOpenPrSuccessOutput, buildPromptVariables, implementationChangeSummary, optionalPricedModelsForRun, promptOverride, publicationPrForTelemetry, repoMemoryDistillTarget, resolveOpenPrBody, resolveOpenPrTitle, resolveRunPriceLookup, resolveSlackMessageInput, resolveTicketStatusInput, resolveV2PromptDataConfiguration, reviewAgentExecutionResult, shouldPromoteResearchWriteScope, soleActiveBlockId, v2NonAgentPromptPlaceholderIssue, v2OpenPrRepositoriesProvenanceIssue, v2TerminalBlockResult } from "./helpers/prompt-output.js";
import { checksBudgetObserver, definitionRequestsRepairCycles, errorMessage, failureExitPhase, isRepositoryScriptsFailurePhase, nodeCanRecordGate, recoverLatestRepositoryScriptsFailureFromSteps, repositoryScriptsFailureComment, truncateError } from "./helpers/repository-failure.js";
import { postReviewLedgerFailureNoteStep, readLedgerEvidenceFileStep, settleReviewLedgerThreads } from "./steps/review-ledger.js";
import { applyReviewLedgerGate, buildResolutionEvidenceComment, pendingPrCheckIntent, resolveNoChangeAction, reviewLedgerOutputFields, reviewLedgerRepoLocalPath, runLedgerEvidenceSecondPass, settledAnswerCount, toLedgerGuardWorkItems, toReviewThreadDispositions, unsettledWorkItemAliases } from "./helpers/review-ledger.js";

export { execute as executeRunScripts } from "./blocks/run-scripts/execute.js";

export function recordPrePrFixCycleUsages(
  ctx: Pick<EngineCtx, "markLaunched" | "recordUsage">,
  usages: ReadonlyArray<PhaseUsage | null>,
  provider: CostProviderKind,
  model: string,
  budgetFailure: RunBudgetFailure | null = null,
  attempt?: number,
  blockId?: string,
): void {
  usages.forEach((usage, index) => {
    const label = blockId
      ? `Pre-PR ${blockId} Fix ${index + 1}`
      : `Pre-PR Fix ${index + 1}`;
    if (attempt === undefined) {
      ctx.markLaunched(label);
      ctx.recordUsage(label, usage, { provider, model });
    } else {
      ctx.markLaunched(label, attempt);
      ctx.recordUsage(label, usage, { provider, model }, attempt);
    }
  });
  if (budgetFailure) throw new RunBudgetError(budgetFailure);
}

/**
 * Scratch agent sandboxes are not part of the code-workspace checkpoint.
 * Detach them before a hook suspension so resume can never reuse an expired
 * sandbox ID.
 */
export function detachScratchSandboxesForClarification(
  ctx: Pick<EngineCtx, "agentSandboxIds" | "sandboxIds">,
): string[] {
  const sandboxIds = [...new Set(Object.values(ctx.agentSandboxIds))];
  for (const sandboxId of sandboxIds) ctx.sandboxIds.delete(sandboxId);
  for (const key of Object.keys(ctx.agentSandboxIds)) {
    delete ctx.agentSandboxIds[key];
  }
  return sandboxIds;
}

/** Build the planning clarification envelope once so persisted step output and
 * the interpreter-facing fields cannot drift apart. */
export function planningClarificationResult(
  questions: string[],
  suggestedAnswers?: string[],
): Extract<BlockExecutionResult, { kind: "needs_human_input" }> {
  const suggestions =
    suggestedAnswers && suggestedAnswers.length > 0 ? suggestedAnswers : undefined;
  return {
    kind: "needs_human_input",
    output: {
      status: "needs_human_input",
      questions,
      ...(suggestions ? { suggestedAnswers: suggestions } : {}),
    },
    questions,
    ...(suggestions ? { suggestedAnswers: suggestions } : {}),
  };
}

/** Entry kinds that own the ticket's main work thread and may run the re-pickup
 *  clarification housekeeping (label strip, pending supersede, awaiting flip). A
 *  pr_trigger / plan_approved run is a PR/plan follow-up that does not own the
 *  ticket's clarification state, so it must be excluded: superseding a live
 *  pending question or flipping the parked asking run to success would silently
 *  strand the human's question with nothing left to re-pick the ticket up. */
/** Entry kinds whose no_change terminal must replay the graph's configured
 *  ticket move. The terminal skips the downstream cone, so update_ticket_status
 *  never runs, and dispatch has no post-success dedup: a ticket left in the AI
 *  column would be picked up again. Only a run dispatched from that column can
 *  be re-picked, so every follow-up is excluded. A pr_trigger run answering
 *  review threads is the case that made this explicit: it would move a ticket
 *  that is usually long since done, and write to Jira on behalf of a reviewer
 *  who asked a question about a pull request. */
export function entryNeedsTicketStatusReplay(
  entry: AgentWorkflowInput | AgentWorkflowInput["kind"],
): boolean {
  return (typeof entry === "string" ? entry : entry.kind) === "ticket";
}

export function entryOwnsClarificationThread(
  entry: AgentWorkflowInput | AgentWorkflowInput["kind"],
): boolean {
  if (
    typeof entry !== "string" &&
    "continuation" in entry &&
    entry.continuation?.kind === "clarification"
  ) {
    return false;
  }
  const kind = typeof entry === "string" ? entry : entry.kind;
  return kind === "ticket";
}

/** Resolve both ways a durable run can encounter schema v1: the current loader
 * rejects it, while a resumed workflow may replay a plan snapshot already in
 * the journal. The workflow body itself uses this seam, so its tests execute the
 * same branch rather than inspecting agent.ts as text. */
export async function loadWorkflowPlanWithRetirementExit<
  Plan extends { definition: unknown },
>(input: {
  load(): Promise<Plan | null>;
  retire(reason: typeof RETIRED_SCHEMA_MESSAGE): Promise<"failed">;
}): Promise<Plan | null | "failed"> {
  let plan: Plan | null;
  try {
    plan = await input.load();
  } catch (error) {
    if (!(error instanceof Error && error.message === RETIRED_SCHEMA_MESSAGE)) {
      throw error;
    }
    return input.retire(RETIRED_SCHEMA_MESSAGE);
  }
  if (!plan) return null;
  const { isLegacyStoredWorkflowDefinition } = await import(
    "../workflow-definition/stored-definition.js"
  );
  return isLegacyStoredWorkflowDefinition(plan.definition)
    ? input.retire(RETIRED_SCHEMA_MESSAGE)
    : plan;
}

export interface RetiredWorkflowFailureDeps {
  ticketKey: string | undefined;
  cleanupClarifications(): Promise<void>;
  markRunFailed(): Promise<void>;
  recordFailureReason(reason: string): Promise<void>;
  logFailure(reason: string): Promise<void>;
  commentFailure(reason: string): Promise<void>;
  moveTicket(): Promise<void>;
  notifyTicket(reason: string): Promise<void>;
}

/** The concrete standard failure exit for a retired plan. It records the run
 * state and reason before provider side effects, preserves the Jira comment
 * path, and returns the durable workflow outcome. */
export async function runRetiredWorkflowFailureExit(
  reason: typeof RETIRED_SCHEMA_MESSAGE,
  deps: RetiredWorkflowFailureDeps,
): Promise<"failed"> {
  await deps.cleanupClarifications();
  await deps.markRunFailed();
  await deps.recordFailureReason(reason);
  const { handleWorkflowFailureExit } = await import("./runtime/workflow-failure-exit.js");
  await handleWorkflowFailureExit(deps.ticketKey, {
    logFailure: () => deps.logFailure(reason),
    commentFailure: () => deps.commentFailure(reason),
    moveTicket: deps.moveTicket,
    notifyTicket: () => deps.notifyTicket(reason),
  });
  return "failed";
}

export const SCHEDULED_RUN_CANNOT_PARK_REASON =
  "This run was started by a schedule, which runs unattended, but a block asked a person for input. Nobody can answer a scheduled run: it has no ticket to comment on and no way to be resumed, so it stops here instead of holding the schedule. Give the workflow enough context to finish on its own, or move this work to a ticket trigger.";

/**
 * A scheduled run must fail rather than park.
 *
 * The deployment gate refuses the two blocks that exist to wait for a person, but
 * parking is a RUNTIME outcome, not a property of a block type: planning,
 * implementation, fix and generic agents can all decide they need input, repo
 * discovery can, terminate and loop can. A schedule graph made only of ordinary
 * blocks therefore still reaches this, and the consequence is silent and
 * expensive. The park notifications are all gated on entry.ticketKey, which a
 * scheduled run does not have, so nothing is posted anywhere; the subject stays
 * claimed for the clarification hook's whole lifetime, which freezes the schedule
 * under skip and queue; and the parked claim holds one of the three concurrency
 * slots for that entire period.
 *
 * Failing releases the subject through the ordinary failure path, so the next
 * occurrence runs. The reason is written for the operator reading a failed run.
 */
export function assertScheduledRunMayNotPark(entry: AgentWorkflowInput): void {
  if (entry.kind !== "schedule") return;
  throw new Error(SCHEDULED_RUN_CANNOT_PARK_REASON);
}

export {
  repositoryScriptFailureEntry,
  repositoryScriptsOutput,
  repositoryScriptsStatus,
  type RepositoryScriptsOutput,
} from "./blocks/support/repository-scripts-output.js";

const FAILURE_PHASES = new Set(["research", "impl", "review", "pre-pr-checks", "push"]);

type NotifyPhase = "research" | "impl" | "review" | "pre-pr-checks" | "push";

function phaseKey(base: string, attempt: number): string {
  return attempt <= 1 ? base : `${base} #${attempt}`;
}

export async function reconcileRunBudgetErrorAtBoundary(
  caught: unknown,
  observeBudget: (requireRemainingDuration: boolean) => Promise<RunBudgetObservation>,
): Promise<unknown> {
  if (
    isRunControlError(caught) ||
    isChecksCeilingExceededError(caught) ||
    isDurationAbortError(caught) ||
    isV2InvocationCancelledError(caught)
  ) {
    return caught;
  }
  const observation = await observeBudget(false);
  return observation.check.status === "ok"
    ? caught
    : new RunBudgetError(observation.check);
}

/** Graph engines must not flatten errors whose identity drives workflow-level
 * terminal handling. Keep this as the single predicate supplied to both
 * schema engines. */
export function shouldRethrowAgentExecutionError(error: unknown): boolean {
  return isRunControlError(error) || isChecksCeilingExceededError(error);
}

/** Classify an error that reached the workflow boundary after graph execution. */
export function unhandledAgentExecutionError(
  error: unknown,
  currentBlockId: string | null,
) {
  return isChecksCeilingExceededError(error)
    ? executionError(checksCeilingErrorDetail(error), {
        category: "checks",
        message: error.message,
      }).error
    : executionError(errorMessage(error), {
        category: currentBlockId ? "unknown" : "engine",
        phase: currentBlockId ? undefined : "engine",
      }).error;
}

// --- Main Workflow ---

export async function agentWorkflow(input: string | AgentWorkflowInput) {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  const legacyInput = typeof input === "string";
  const entry: AgentWorkflowInput = legacyInput
      ? {
        kind: "ticket",
        subjectKey: `ticket:jira:${input.trim().toUpperCase()}`,
        ticketKey: input,
        ownerToken: `legacy:${workflowRunId}`,
      }
    : input;
  if (!legacyInput) {
    const {
      acknowledgeApprovalDispatchStep,
      acknowledgeManualDispatchStep,
      acknowledgePendingTriggerStep,
      acknowledgePrTriggerDispatchStep,
      acknowledgeScheduleDispatchStep,
      acknowledgeWebhookDispatchStep,
      bindWorkflowCandidateStep,
    } = await import("./steps/run-ownership-steps.js");
    const bound = await bindWorkflowCandidateStep(
      entry.subjectKey,
      entry.ownerToken,
      workflowRunId,
      entry.ticketKey ?? null,
      runKindForAgentWorkflowInput(entry),
    );
    if (!bound) return;
    await acknowledgeManualDispatchStep(entry, workflowRunId);
    await acknowledgeApprovalDispatchStep(entry, workflowRunId);
    if (!(await acknowledgePrTriggerDispatchStep(entry, workflowRunId))) return;
    if (!(await acknowledgeWebhookDispatchStep(entry, workflowRunId))) return;
    if (!(await acknowledgeScheduleDispatchStep(entry, workflowRunId))) return;
    await acknowledgePendingTriggerStep(entry);
  }
  const result = await agentWorkflowBody(entry, workflowRunId);
  if (result && typeof result === "object") {
    throw new WorkflowExecutionError(result.error);
  }
}

async function agentWorkflowBody(
  entry: AgentWorkflowInput,
  workflowRunId: string,
): Promise<
  | "success"
  | "failed"
  | "awaiting"
  | { kind: "execution_error"; error: WorkflowExecutionErrorState }
  | undefined
> {
  // FIRST, before any other step: what this run decided before it did
  // anything. Everything below reads settings and repository access off these
  // two values, never off the environment or a store, so an operator who saves
  // the Settings page or disables a repository while this run is in flight
  // moves the NEXT run and leaves this one's journal consistent on replay.
  const { loadRunStartSettingsStep, runStartRepositoryAccess, runStartSettings } =
    await import("./steps/run-start-settings.js");
  const runStart = await loadRunStartSettingsStep();
  // Through the accessors, never off the stored result: a run suspended across
  // a deploy that adds a registry key replays a snapshot written without it,
  // and these two fill the gap with what the deployment would have defaulted to
  // rather than handing the run `undefined`.
  const runSettings = runStartSettings(runStart);
  const runRepositories = runStartRepositoryAccess(runStart);

  // After the settings read, deliberately. The budget clock starts when the run
  // starts doing work, and the step above is the run reading its own
  // configuration; a database blip there burns its retry window inside the
  // budget otherwise, so a run could exhaust part of its wall clock before the
  // first block existed. Do not reorder these two.
  const budgetStartedAtMs = await readRunBudgetClockStep();

  const { env } = await import("./harness-profiles/model-env.js");
  const { assembleResearchPlanContext, assembleImplementationContext, assembleReviewContext } =
    await import("../sandbox/context.js");
  const {
    collectPhase,
    collectPhaseReplayDiagnostics,
    teardownSandboxes,
  } =
    await import("./steps/sandbox-poll-agent.js");
  const { openPullRequestsForPublication } = await import("./steps/workspace-publication.js");
  const { formatUsageReport } = await import("../sandbox/usage.js");
  const { AGENT_SCHEMA, RESEARCH_SCHEMA, REVIEW_SCHEMA } = await import("../sandbox/agents/types.js");
  // The column names come from the run's snapshot; the two transition ids stay
  // on `env` because they are not registry keys (a Jira transition id is a
  // board's internal identifier, not an operator setting).
  const backlogMoveTarget = (): IssueTrackerMoveTarget =>
    env.JIRA_BACKLOG_TRANSITION_ID
      ? {
          name: runSettings.COLUMN_BACKLOG,
          transitionId: env.JIRA_BACKLOG_TRANSITION_ID,
        }
      : runSettings.COLUMN_BACKLOG;
  const aiReviewMoveTarget = (): IssueTrackerMoveTarget =>
    env.JIRA_AI_REVIEW_TRANSITION_ID
      ? {
          name: runSettings.COLUMN_AI_REVIEW,
          transitionId: env.JIRA_AI_REVIEW_TRANSITION_ID,
        }
      : runSettings.COLUMN_AI_REVIEW;

  const ticketId = entry.ticketKey ?? entry.subjectKey;
  const transitionOwner = {
    subjectKey: entry.subjectKey,
    ownerToken: entry.ownerToken,
    runId: workflowRunId,
  };

  const { resolveWorkflowTicketStep } = await import("./steps/workflow-ticket.js");
  const ticket = await resolveWorkflowTicketStep(entry, runSettings.COLUMN_AI);
  if (!ticket) return;

  let clarificationsReconciled = false;
  const cleanupClarifications = async (): Promise<void> => {
    if (clarificationsReconciled) return;
    clarificationsReconciled = true;
    if (entryOwnsClarificationThread(entry)) {
      await reconcileClarificationsOnPickup(
        ticket.identifier,
        workflowRunId,
        transitionOwner,
      );
    }
  };
  const failRetiredDefinition = async (
    reason: typeof RETIRED_SCHEMA_MESSAGE,
  ): Promise<"failed"> => {
    try {
      return await runRetiredWorkflowFailureExit(reason, {
        ticketKey: entry.ticketKey ?? undefined,
        cleanupClarifications,
        markRunFailed: () => markRunFailedOnSelfMoveStep(workflowRunId),
        recordFailureReason: (failureReason) =>
          recordRunFailureReasonStep(workflowRunId, failureReason),
        logFailure: (failureReason) =>
          logPhaseFailure(entry.subjectKey, "engine", failureReason),
        commentFailure: (failureReason) =>
          postFailureReasonCommentStep(
            ticket.identifier,
            failureReason,
            transitionOwner,
          ),
        moveTicket: () =>
          moveTicketStep(ticketId, backlogMoveTarget(), transitionOwner),
        notifyTicket: (failureReason) =>
          notifyTicket(
            ticket.identifier,
            { kind: "failed", reason: failureReason },
            transitionOwner,
          ),
      });
    } finally {
      const retiredExecutionError = createWorkflowExecutionErrorState(
        workflowRunId,
        "workflow-definition",
        1,
        executionError(reason, {
          category: "engine",
          message: reason,
          phase: "workflow-definition",
        }).error,
      );
      await persistRunTelemetryBestEffort(
        {
          runId: workflowRunId,
          subjectKey: entry.subjectKey,
          status: "failed",
          ticketKey: entry.ticketKey ?? null,
          ticketTitle: ticket.title,
          ticketUrl: entry.ticketKey
            ? `${env.JIRA_BASE_URL.replace(/\/+$/, "")}/browse/${ticket.identifier}`
            : entry.kind === "pr_trigger"
              ? entry.pr.prUrl
              : null,
          model: null,
          totals: computeUsageTotals({}, {}, undefined, undefined, {}),
          budgetFailure: null,
          pr: null,
          prs: null,
          executionError: {
            message: formatExecutionErrorForUser(retiredExecutionError),
            code: retiredExecutionError.diagnosticId,
          },
          harnessManifests: [],
        },
      );
    }
  };
  // Re-pickup housekeeping (strip the awaiting-input label, supersede any pending
  // clarification, flip parked predecessor runs off "awaiting"). Gated to the
  // entry kinds that own the ticket's main work thread: a plain "ticket" pickup
  // or a clarification answer whose checkpoint could not be restored. A restored
  // continuation uses only the isolated label repair above. A pr_trigger /
  // plan_approved run is a PR/plan follow-up that must NOT touch the ticket's
  // clarification state. All operations inside are idempotent, so this is a safe
  // no-op on a first pickup too.
  await cleanupClarifications();

  // First pickup only: post exactly one dashboard link comment so a human can
  // follow progress and answer questions. The link itself is the idempotency
  // marker (hasDashboardLinkComment), so a re-picked ticket that already has it
  // posts nothing. Ticket-triggered runs only: pr_trigger and plan_approved
  // runs are follow-ups on a ticket the bot already commented on.
  if (
    entry.kind === "ticket" &&
    !("continuation" in entry && entry.continuation) &&
    !hasDashboardLinkComment(ticket.comments, ticket.identifier)
  ) {
    await postPickupCommentStep(ticket.identifier, transitionOwner);
  }

  const { loadPrompts } = await import("./steps/prompts-step.js");
  const prompts = await loadPrompts();

  const { loadWorkflowDefinitionFor } = await import("./steps/definition-step.js");
  const entryTriggerType = triggerTypeFor(entry);
  // An approved plan pins the definition version that produced it, so the run
  // replays the exact graph the human reviewed rather than the current head.
  const pinnedVersion = "definitionVersion" in entry ? entry.definitionVersion : undefined;
  const loadedPlan = await loadWorkflowPlanWithRetirementExit({
    load: () =>
      loadWorkflowDefinitionFor(
        runSettings,
        entryTriggerType,
        entry.definitionId,
        pinnedVersion,
      ),
    retire: failRetiredDefinition,
  });
  if (loadedPlan === "failed") return loadedPlan;
  const plan = loadedPlan;
  if (!plan) {
    console.warn(
      `No runnable workflow definition for trigger ${entryTriggerType}; skipping run for ${ticket.identifier}`,
    );
    return;
  }
  if (entry.kind === "pr_trigger" && entry.scope === "any") {
    const issues = await validateReviewSafePlanStep(plan.nodes, plan.edges);
    if (issues.length > 0) {
      throw new Error(`scope:any workflow is not review-safe: ${issues.join("; ")}`);
    }
  }

  const agentKindOverride = await resolveAgentKindOverride(ticket.labels);
  const runDefaultKind: AgentKind = resolveRunDefaultKind(
    agentKindOverride,
    runSettings.AGENT_KIND,
  );
  // One definition of "the model this deployment defaults to", shared with the
  // block contract context so the two cannot drift.
  const { runModelDefaults } = await import("./definition/block-contract-environment.js");
  const modelDefaults = runModelDefaults(runSettings);
  const defaultModel = modelDefaults[runDefaultKind];
  const harnessRuntimes = await resolveHarnessRuntimesStep(
    plan.definition,
    runDefaultKind,
    agentKindOverride,
  );
  const harnessManifests: HarnessRunManifestRecord[] = Object.values(
    harnessRuntimes,
  )
    .map((runtime) => structuredClone(runtime.safeManifest))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const budgetLimits: RunBudgetLimits = {
    maxDurationMs: plan.budgets?.maxDurationMs ?? runSettings.JOB_TIMEOUT_MS,
    maxDurationSource:
      plan.budgets?.maxDurationMs === undefined ? "env" : "definition",
    ...(plan.budgets?.maxTokens !== undefined
      ? { maxTokens: plan.budgets.maxTokens }
      : {}),
    ...(plan.budgets?.maxCostUsd !== undefined
      ? { maxCostUsd: plan.budgets.maxCostUsd }
      : {}),
  };
  let budgetState: RunBudgetState = createRunBudgetState();
  let lastBudgetClockMs = budgetStartedAtMs;
  const observeBudgetAtBoundary = async (
    requireRemainingDuration: boolean,
    attribution: RunBudgetAttribution = "duration",
    observedAtMs?: number,
  ): Promise<RunBudgetObservation> => {
    const now = observedAtMs ?? await readRunBudgetClockStep();
    // The clock is journaled, so a replay re-reads the same instants and lands
    // on the same split between the two totals. Attributing from Date.now()
    // here would give a resumed run a different checks bill than the one it
    // was already charged.
    budgetState = addElapsed(budgetState, now - lastBudgetClockMs, attribution);
    lastBudgetClockMs = Math.max(lastBudgetClockMs, now);
    return {
      ...observeRunBudget(budgetState, budgetLimits, requireRemainingDuration),
      observedAtMs: lastBudgetClockMs,
    };
  };
  const enforceBudgetAtBoundary = async (requireRemainingDuration: boolean): Promise<void> => {
    const observation = await observeBudgetAtBoundary(requireRemainingDuration);
    if (observation.check.status !== "ok") throw new RunBudgetError(observation.check);
  };

  const { resolvePromptReferencesForRun } = await import("./steps/prompt-references-step.js");
  const resolvedPrompts = await resolvePromptReferencesForRun(plan.nodes);
  plan.nodes = resolvedPrompts.nodes;
  {
    const definition = plan.definition;
    const resolvedConfigurationByNodeId = new Map(
      plan.nodes.map((node) => [node.id, node.params] as const),
    );
    plan.definition = {
      ...definition,
      nodes: definition.nodes.map((node) => {
        const resolved = resolvedConfigurationByNodeId.get(node.id);
        if (!resolved) return node;
        const configuration = structuredClone(node.configuration);
        for (const key of VARIABLE_PARAM_KEYS[node.type] ?? []) {
          const value = resolved[key];
          if (value !== undefined) {
            configuration[key] = structuredClone(value);
          }
        }
        return Object.assign({}, node, { configuration });
      }),
    } as WorkflowDefinitionV2;
  }

  const blockStatuses: Record<string, BlockRunState> = Object.fromEntries(
    plan.nodes
      .filter((node) => !isTriggerBlockType(node.type))
      .map((node): [string, BlockRunState] => [node.id, { status: "pending" }]),
  );
  let currentBlockId: string | null = null;
  const activeBlockIds = new Set<string>();
  // Attribution for the terminal diagnostic on the catch path, which reads
  // currentBlockId for its nodeId, category and phase. See soleActiveBlockId.
  const syncCurrentBlockId = (): void => {
    currentBlockId = soleActiveBlockId(activeBlockIds);
  };
  const writeBlockStatuses = () =>
    recordBlockStatusesStep({
      runId: workflowRunId,
      subjectKey: entry.subjectKey,
      ticketKey: entry.ticketKey ?? null,
      ticketTitle: ticket.title,
      ticketUrl: entry.ticketKey
        ? `${env.JIRA_BASE_URL.replace(/\/+$/, "")}/browse/${ticket.identifier}`
        : entry.kind === "pr_trigger"
          ? entry.pr.prUrl
          : null,
      definitionVersion: plan.version,
      definitionId: plan.definitionId,
      blockStatuses: { ...blockStatuses },
      promptManifest: resolvedPrompts.manifest,
      harnessManifests,
    }).catch(() => {});
  await writeBlockStatuses();
  let v2RunObservation: V2RunObservationHooks | null = null;
  {
    const replayCaptureStartedAt = await readRunBudgetClockStep();
    const definition = plan.definition;
    const replayGraph = sanitizeReplayGraphSnapshot(
      buildV2ReplayGraphSnapshot(definition),
      configuredReplaySecrets(),
    );
    const capture = replayGraph
      ? await captureV2RunObservationStartStep({
          runId: workflowRunId,
          definitionId: plan.definitionId,
          definitionVersion: plan.version,
          graph: replayGraph,
          runtimeManifest: sanitizeReplayValue(
            {
              defaultAgent: {
                provider: runDefaultKind,
                model: defaultModel,
              },
              harnesses: harnessManifests,
            },
            { secrets: configuredReplaySecrets() },
          ),
        })
      : null;
    if (capture) {
      const common = {
        runId: workflowRunId,
        organizationId: capture.organizationId,
      };
      const pendingObservations = new Map<
        number,
        SanitizedReplayObservation[]
      >();
      let replayCaptureUnavailable = false;
      const takePendingObservations = (
        attemptId: number,
        terminal: boolean,
      ): SanitizedReplayObservation[] => {
        const observations = pendingObservations.get(attemptId) ?? [];
        if (terminal) pendingObservations.delete(attemptId);
        else pendingObservations.set(attemptId, []);
        return observations;
      };
      v2RunObservation = createV2RunObservationHooks({
        nodeTypes: new Map(
          definition.nodes.map((node) => [node.id, node.type] as const),
        ),
        sink: {
          async start(identity, startedAt) {
            if (replayCaptureUnavailable) return null;
            const attemptId = await startV2RunObservationAttemptStep({
              ...common,
              ...identity,
              startedAt: startedAt.toISOString(),
            });
            if (replayCaptureUnavailable) return null;
            if (attemptId !== null && !pendingObservations.has(attemptId)) {
              pendingObservations.set(attemptId, []);
            }
            return attemptId;
          },
          async observe(attemptId, observation) {
            const observations = pendingObservations.get(attemptId);
            if (!observations) return;
            observations.push({
              kind: observation.kind,
              envelope: sanitizeReplayValue(observation.value, {
                secrets: configuredReplaySecrets(),
                retain:
                  observation.kind === "log" ? "tail" : "head",
              }),
            });
          },
          async flush(attemptId) {
            const observations = takePendingObservations(attemptId, false);
            if (observations.length === 0) return;
            const captured = await flushV2RunObservationsStep({
              ...common,
              attemptId,
              observations,
            });
            if (!captured) {
              throw new Error("Replay observation flush failed");
            }
          },
          async updateWaiting(attemptId, selectedTransition) {
            const captured = await updateV2RunObservationWaitingStep({
              ...common,
              attemptId,
              selectedTransition,
              observations: takePendingObservations(attemptId, false),
            });
            if (!captured) {
              throw new Error("Replay waiting-state capture failed");
            }
          },
          async finish(attemptId, finish, completedAt) {
            const outcome =
              sanitizeReplayAttemptOutcome(
                finish.outcome,
                configuredReplaySecrets(),
              ) ?? {
                kind: finish.outcome.kind,
                status: "unavailable",
              };
            const captured = await finishV2RunObservationAttemptStep({
              ...common,
              attemptId,
              ...finish,
              outcome,
              observations: takePendingObservations(attemptId, true),
              completedAt: completedAt.toISOString(),
            });
            if (!captured) {
              throw new Error("Replay attempt finalization failed");
            }
          },
          async markUnavailable() {
            replayCaptureUnavailable = true;
            pendingObservations.clear();
            await markV2RunObservationUnavailableStep(common);
          },
        },
      });
    }
    const replayCaptureFinishedAt = await readRunBudgetClockStep();
    lastBudgetClockMs += Math.max(
      0,
      replayCaptureFinishedAt - replayCaptureStartedAt,
    );
  }

  const phaseUsages: Record<string, PhaseUsage | null> = {};
  const phaseProviders: Record<string, CostProviderKind | undefined> = {};
  const phaseModels: Record<string, string> = {};
  // The cumulative maps feed downstream notifications and the next checkpoint.
  // Run-local maps keep per-run telemetry additive instead of charging restored
  // predecessor usage a second time.
  const runPhaseUsages: Record<string, PhaseUsage | null> = {};
  const runPhaseProviders: Record<string, CostProviderKind | undefined> = {};
  const runPhaseModels: Record<string, string> = {};
  // Phases whose agent was launched. A phase that times out or exits before
  // its usage is parsed never gets a phaseUsages entry; the finally reconciles
  // any such launched-but-missing phase to null so computeUsageTotals flags
  // costKnown=false instead of reporting a misleading costUsd=0 / costKnown=true.
  const launchedPhases = new Set<string>();
  const reconcileMissingPhaseUsages = (): void => {
    for (const phase of launchedPhases) {
      if (phase in phaseUsages) continue;
      phaseUsages[phase] = null;
      runPhaseUsages[phase] = null;
      budgetState = recordBudgetUsage(budgetState, null, null, phase);
    }
  };
  // Captured on the success path; written as run telemetry in the finally.
  let prForTelemetry: { url: string; number: number } | null = null;
  let prsForTelemetry: RunPullRequest[] | null = null;
  // Authoritative terminal status for telemetry, written in the finally on
  // every exit path. Defaults to "failed". The genuine PR-opened success flips
  // it to "success"; the clarification exits record "awaiting" (the run is
  // parked, not done: the answer endpoint or the re-pickup housekeeping later
  // flips it to success). Every phase failure / timeout / thrown error keeps
  // "failed".
  let runOutcome: "success" | "failed" | "awaiting" = "failed";
  let terminalExecutionError: WorkflowExecutionErrorState | null = null;
  let terminalBudgetFailure: RunBudgetFailure | null = null;
  // Seeded with the run default model once prepare_workspace provisions the
  // sandbox, then set to the implementation block's model once it runs.
  let activeModel: string | undefined;
  let priceLookup: ((m: string) => TokenPrice | null) | undefined;
  // The phase's model price rides along whatever provider recorded the usage,
  // and even when no provider was stated: a token-only usage stays priceable,
  // which is what keeps a run under a cost cap verifiable.
  const costProviderFor = (model: string): CostProvider => ({
    price: priceLookup?.(model) ?? null,
  });
  // Returns the formatted usage report when any phase has produced usage,
  // otherwise undefined so the messaging formatter can omit the trailing block.
  const usageReportOrUndefined = (): string | undefined =>
    Object.keys(phaseUsages).length > 0
      ? formatUsageReport(
          phaseUsages,
          phaseProviders,
          priceLookup,
          activeModel,
          phaseModels,
        )
      : undefined;

  try {
    if (entry.ticketKey) {
      await notifyTicket(ticket.identifier, { kind: "started" }, transitionOwner);
    }

    const entryTrigger = selectEntryTriggerNode(plan.nodes, entryTriggerType, entry);
    if (!entryTrigger) {
      throw new Error("workflow definition has no runnable trigger block");
    }
    const branchName =
      entry.kind === "pr_trigger" && !entry.ticketKey
        ? entry.pr.headRef
        : branchForTicket(ticket.identifier);
    const downloadedAttachments = await fetchAttachments(
      ticket.identifier,
      ticket.attachments,
      {
        maxFileSizeBytes: runSettings.ATTACHMENT_MAX_FILE_SIZE_MB * 1024 * 1024,
        maxTotalSizeBytes: runSettings.ATTACHMENT_MAX_TOTAL_SIZE_MB * 1024 * 1024,
        maxCount: runSettings.ATTACHMENT_MAX_COUNT,
        downloadTimeoutMs: runSettings.ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
      },
    );

    // Ticket-backed history is reloaded from the DB. Same-run clarification
    // answers are appended to this local context when their hook resumes.
    let clarificationHistory:
      | Array<{ questions: string[]; answer: string; answeredBy?: string; answeredAt?: string }>
      | undefined;
    if (entry.ticketKey) {
      try {
        for (const round of await loadClarificationHistoryStep(ticket.identifier)) {
          clarificationHistory = appendClarificationRound(clarificationHistory, round);
        }
      } catch (err) {
        await logClarificationHistoryFailure(ticket.identifier, errorMessage(err));
      }
    }

    const ticketData = {
      identifier: ticket.identifier,
      title: ticket.title,
      description: ticket.description,
      acceptanceCriteria: ticket.acceptanceCriteria,
      comments: ticket.comments,
      labels: ticket.labels,
      ...(clarificationHistory && clarificationHistory.length > 0
        ? { clarifications: clarificationHistory }
        : {}),
    };
    const triggerOutput: BlockOutput = triggerOutputWithTicketContext(entry, ticketData);

    const resolveAgentForNode = (node: WorkflowDefinitionNode) => {
      const runtime = harnessRuntimes[node.id];
      return runtime
        ? {
            kind: runtime.manifest.harness.provider,
            model: runtime.manifest.model.id,
            runtime,
          }
        : {
            ...resolveBlockAgent(
              node.params,
              runDefaultKind,
              modelDefaults,
            ),
            runtime: undefined,
          };
    };

    // Codex agents and every in-process Call LLM need token pricing. Fetch all
    // resolved models before any block can record usage so configured cost caps
    // fail closed instead of depending on network timing during execution.
    const pricedModels = new Set([
      ...Object.values(harnessRuntimes)
        .filter((runtime) => runtime.manifest.harness.provider === "codex")
        .map((runtime) => runtime.manifest.model.id),
      ...plan.nodes
        .filter((node) => node.type === "call_llm")
        .map(
          (node) =>
            resolveCallLlmTarget(node.params, runDefaultKind, modelDefaults)
              .model,
        ),
    ]);
    if (
      runDefaultKind === "codex" &&
      plan.nodes.some((node) =>
        node.type === "run_pre_pr_checks" ||
        node.type === "finalize_workspace" ||
        node.type === "open_pr"
      )
    ) {
      pricedModels.add(modelDefaults.codex);
    }
    for (const [phase, usage] of Object.entries(phaseUsages)) {
      const model = phaseModels[phase];
      if (usage?.tokens && model) pricedModels.add(model);
    }
    // The distill's model is priced but not required. Nothing above resolves it:
    // it is neither a definition node nor a harness runtime, so without this its
    // usage would land with an unknown cost and mark the whole run unknown.
    priceLookup = await resolveRunPriceLookup({
      requiredModels: pricedModels,
      optionalModels: optionalPricedModelsForRun({
        enableRepoMemory: runSettings.ENABLE_REPO_MEMORY,
        runDefaultKind,
        defaults: modelDefaults,
      }),
      maxCostUsd: budgetLimits.maxCostUsd,
      fetchPrice: (model) => fetchModelPriceStep(model),
    });

    const state: {
      implementationModel: string;
      implementationKind: AgentKind | undefined;
      implementationRuntime: ResolvedHarnessRuntime | undefined;
      attempt: number;
    } = {
      implementationModel: defaultModel,
      implementationKind: undefined,
      implementationRuntime: undefined,
      attempt: 1,
    };

    const initialAnalysisReport =
      entry.kind === "plan_approved"
        ? await loadApprovedPlanAnalysisReportBestEffort(workflowRunId, entry.approvedPlan.sourceRunId, entry)
        : null;
    if (initialAnalysisReport) {
      await recordRunAnalysisReportBestEffort(initialAnalysisReport);
    }
    const ctx: EngineCtx = {
      runId: workflowRunId,
      settings: runSettings,
      repositories: runRepositories,
      definitionId: plan.definitionId,
      definitionVersion: plan.version,
      definitionNodes: plan.nodes,
      entry,
      ticket,
      ticketUrl: entry.ticketKey
        ? `${env.JIRA_BASE_URL.replace(/\/+$/, "")}/browse/${ticket.identifier}`
        : "",
      changeSummary: "",
      ...(clarificationHistory && clarificationHistory.length > 0
        ? { clarifications: clarificationHistory }
        : {}),
      branchName,
      sandboxId: null,
      workspaceManifest: null,
      agentSandboxIds: {},
      harnessRuntimes,
      sandboxIds: new Set<string>(),
      reviewSourceFingerprints: new Map<string, string>(),
      selectedRepositories: [],
      repositoryContexts: [],
      repositoryDiscovery: null,
      ...(plan.repositoryScope ? { repositoryScope: plan.repositoryScope } : {}),
      repositoryExpansion: { rounds: 0, priorRequests: [] },
      researchWriteRepositories: [],
      preSandboxAdditions: {
        research: [],
        implementation: [],
        review: [],
      },
      researchPlanMarkdown:
        entry.kind === "plan_approved"
          ? entry.approvedPlan.markdown
          : "",
      analysisReport: initialAnalysisReport,
      analysisRevision: initialAnalysisReport?.researchRevision ?? 0,
      publication: null,
      prePrGate: null,
      runDefaultKind,
      defaults: modelDefaults,
      prompts,
      moveTargets: { backlog: backlogMoveTarget(), aiReview: aiReviewMoveTarget() },
      arthur: {
        taskId: null,
      },
      checksCeilingMs: null,
      prePrChecksFailureMessage,
      observeBudget: (requireRemainingDuration = true, attribution, observedAtMs?: number) =>
        observeBudgetAtBoundary(requireRemainingDuration, attribution, observedAtMs),
      recordUsage: (label, usage, source, attempt) => {
        const key = phaseKey(label, attempt ?? state.attempt);
        phaseUsages[key] = usage;
        phaseProviders[key] = source.provider;
        phaseModels[key] = source.model;
        runPhaseUsages[key] = usage;
        runPhaseProviders[key] = source.provider;
        runPhaseModels[key] = source.model;
        budgetState = recordBudgetUsage(
          budgetState,
          usage,
          costProviderFor(source.model),
          key,
        );
      },
      markLaunched: (label, attempt) => {
        launchedPhases.add(phaseKey(label, attempt ?? state.attempt));
      },
    };

    try {
      // The review agent works from a disposable checkout that carries only the
      // head commit, so it cannot derive the pull request diff itself. Hand the
      // change set over through the review prompt channel before any block runs.
      // The review channel has exactly one reader, so a definition without a
      // review block must not pay for the provider fetch or journal its result.
      const changeSetTarget = plan.nodes.some((node) => node.type === "review_agent")
        ? pullRequestChangeSetTarget(entry)
        : null;
      if (changeSetTarget) {
        ctx.preSandboxAdditions.review.push(
          await assembleReviewChangeSetAddition(changeSetTarget),
        );
      }

      const awaitClarification = async (
        questions: string[],
        nodeId?: string,
        suggestedAnswers?: string[],
        checkpointSteps?: StepsRecord,
      ): Promise<string> => {
        assertScheduledRunMayNotPark(entry);
        if (!nodeId || !checkpointSteps) {
          throw new Error("clarification is missing its waiting block context");
        }

        const {
          markClarificationHookCleanupStep,
          markRunAwaitingStep,
          markRunResumedStep,
          prepareClarificationHookStep,
          publishClarificationHookStep,
          recordClarificationHookSnapshotStep,
          supersedeClarificationHookStep,
          verifyWorkspaceManifestStep,
        } = await import("./steps/clarification-hook-steps.js");
        const workspaceManifest = ctx.workspaceManifest;
        if (ctx.sandboxId) {
          if (!workspaceManifest) {
            throw new Error("code workspace is missing its trusted provisioned manifest");
          }
          await verifyWorkspaceManifestStep(ctx.sandboxId, workspaceManifest);
        } else if (workspaceManifest) {
          throw new Error("trusted workspace manifest exists without a code sandbox");
        }

        const clarification = await prepareClarificationHookStep({
          ticketKey: entry.ticketKey ?? null,
          subjectKey: entry.subjectKey,
          runId: workflowRunId,
          blockId: nodeId,
          definitionId: plan.definitionId,
          definitionVersion: plan.version,
          questions,
          suggestedAnswers: suggestedAnswers ?? null,
        });
        const hook = createHook<
          | {
              answer: string;
              answeredById: string;
              answeredByLabel: string;
              answeredAt: string;
            }
          | { expired: true }
        >({ token: clarification.hookToken });
        let snapshot:
          | { snapshotId: string; sourceSandboxId: string; expiresAt: string }
          | undefined;
        try {
          const conflict = await hook.getConflict();
          if (conflict) {
            throw new Error(
              `clarification hook ${clarification.hookToken} is already owned by run ${conflict.runId}`,
            );
          }

          const scratchSandboxIds =
            detachScratchSandboxesForClarification(ctx);
          await teardownSandboxes(scratchSandboxIds);

          if (ctx.sandboxId) {
            const snapshotBudget = await observeBudgetAtBoundary(true);
            if (snapshotBudget.check.status !== "ok") {
              throw new RunBudgetError(snapshotBudget.check);
            }
            const { snapshotClarificationSandboxStep } =
              await import("./steps/clarification-snapshot-steps.js");
            snapshot = await snapshotClarificationSandboxStep({
              subjectKey: entry.subjectKey,
              ownerToken: entry.ownerToken,
              clarificationId: clarification.id,
              sandboxId: ctx.sandboxId,
              snapshotRequestedAt: clarification.snapshotRequestedAt,
              timeoutMs: Math.max(1, Math.floor(snapshotBudget.remainingDurationMs)),
            });
            await recordClarificationHookSnapshotStep(clarification.id, snapshot);
            const afterSnapshot = await observeBudgetAtBoundary(false);
            if (afterSnapshot.check.status !== "ok") {
              throw new RunBudgetError(afterSnapshot.check);
            }
          }

          await publishClarificationHookStep(clarification.id);
          // The body suspends on the hook below, so the run's own status writer
          // never runs while it is parked and the cron keeps snapshotting it as
          // "running". Record the park itself, before any of the ticket-side
          // notifications a human can act on. Best-effort like the other two
          // park writes: dashboard bookkeeping must never sink a real park (the
          // cron sweep settles a marker that never landed).
          await markRunAwaitingStep(workflowRunId).catch(() => {});
          if (entry.ticketKey) {
            await parkForClarificationStep(
              ticketId,
              backlogMoveTarget(),
              clarification.id,
              transitionOwner,
            ).catch((error) => {
              if (isRunControlError(error)) throw error;
              console.error(
                `Clarification ticket parking failed for ${clarification.id}`,
              );
              return false;
            });
            const questionsCommentUrl = await postClarificationQuestionsCommentStep(
              ticket.identifier,
              {
                questions,
                suggestedAnswers: suggestedAnswers ?? null,
                dashboardUrl: ticketRunUrl(env.DASHBOARD_ORIGIN, ticket.identifier, workflowRunId),
                expiresAtIso: clarification.expiresAt,
                aiColumnName: runSettings.COLUMN_AI,
              },
              transitionOwner,
            );
            await notifyTicketBestEffort(ticket.identifier, {
              kind: "needs_clarification",
              dashboardUrl: ticketRunUrl(env.DASHBOARD_ORIGIN, ticket.identifier, workflowRunId),
              ...(questionsCommentUrl ? { commentUrl: questionsCommentUrl } : {}),
              questions,
              ...(suggestedAnswers && suggestedAnswers.length > 0 ? { suggestedAnswers } : {}),
              usageReport: usageReportOrUndefined(),
            }, transitionOwner);
          }

          const answered = await hook;
          // First thing after the park, ahead of the expiry branch: that branch
          // throws, and the failure path's markRunFailedOnSelfMove is a no-op on
          // an "awaiting" row, so the run must be back to "running" before any
          // later exit can record its real outcome. Best-effort: the answer is
          // already consumed at this point, so a status write must never be what
          // fails the resumed run.
          await markRunResumedStep(workflowRunId).catch(() => {});
          lastBudgetClockMs = await readRunBudgetClockStep();
          if ("expired" in answered) {
            throw new Error("clarification expired before it was answered");
          }
          // Scratch agent sandboxes have a JOB_TIMEOUT_MS lifetime while the
          // hook stays answerable for days, so any cached id may point at an
          // expired sandbox after the park. Drop the cache so the re-executed
          // block re-provisions; the code workspace is restored from its
          // snapshot separately below.
          ctx.agentSandboxIds = {};
          // Hook suspension is free wall time; only active work counts against
          // the run duration budget.
          if (entry.ticketKey) {
            const { repairClarificationLabelStep } = await import(
              "./steps/run-ownership-steps.js"
            );
            await repairClarificationLabelStep(ticket.identifier, transitionOwner);
          }

          if (snapshot) {
            const { restoreCheckpointSandboxReferences } = await import(
              "./support/clarification-checkpoint.js"
            );
            const { restoreClarificationSandboxStep } = await import(
              "./steps/clarification-snapshot-steps.js"
            );
            const { ensureArthurTask, ensureChecksCeiling, sandboxLifetimeMs } =
              await import("./blocks/prepare-workspace/execute.js");
            const requiredAgents = requiredAgentsForDefinition({
              nodes: plan.nodes,
              defaultKind: runDefaultKind,
              defaults: modelDefaults,
              harnessRuntimes,
            });
            const restoreBudget = await observeBudgetAtBoundary(true);
            if (restoreBudget.check.status !== "ok") {
              throw new RunBudgetError(restoreBudget.check);
            }
            // The checkpoint's own ceiling first: it is the number the sandbox
            // this one replaces was sized against, so a configuration edited
            // while the run was parked cannot change the bound mid-run. Seeded
            // back onto the context so every block after the resume agrees.
            const restoredCeilingMs =
              recoverChecksCeilingFromSteps(checkpointSteps) ??
              (await ensureChecksCeiling(ctx));
            ctx.checksCeilingMs ??= restoredCeilingMs;
            const restored = await restoreClarificationSandboxStep({
              snapshotId: snapshot.snapshotId,
              subjectKey: entry.subjectKey,
              ownerToken: entry.ownerToken,
              // Remaining run duration PLUS the checks ceiling, exactly like
              // every other sandbox that can host a batch (agent-sandbox.ts,
              // prepare-workspace.ts). The checks cap no longer consults the
              // run's duration, so sizing this from the duration alone would
              // kill a resumed run's sandbox under a batch that is well inside
              // its own bound, and report it as a lost workspace.
              timeoutMs: sandboxLifetimeMs(
                restoreBudget.remainingDurationMs,
                restoredCeilingMs,
              ),
              agents: requiredAgents,
              arthurTaskId: await ensureArthurTask(ctx),
            });
            ctx.sandboxId = restored.sandboxId;
            invalidateWorkspaceGate(ctx);
            ctx.reviewSourceFingerprints?.clear();
            ctx.sandboxIds.add(restored.sandboxId);
            const restoredSteps = restoreCheckpointSandboxReferences(
              checkpointSteps,
              snapshot.sourceSandboxId,
              restored.sandboxId,
            );
            for (const key of Object.keys(checkpointSteps)) delete checkpointSteps[key];
            Object.assign(checkpointSteps, restoredSteps);
            if (ctx.selectedRepositories.length > 0) {
              const { blockFetchPrContextsStep } = await import("./blocks/fetch-pr-context/execute.js");
              ctx.repositoryContexts = await blockFetchPrContextsStep(
                ctx.selectedRepositories,
                ctx.repositories,
              );
            }
          }

          const round = {
            questions,
            answer: answered.answer,
            answeredBy: answered.answeredByLabel,
            answeredAt: answered.answeredAt,
          };
          clarificationHistory = appendClarificationRound(clarificationHistory, round);
          ctx.clarifications = appendClarificationRound(ctx.clarifications, round);

          if (snapshot) {
            const { deleteClarificationSnapshotStep } = await import(
              "./steps/clarification-snapshot-steps.js"
            );
            try {
              await deleteClarificationSnapshotStep(snapshot.snapshotId);
              await markClarificationHookCleanupStep(clarification.id, { status: "deleted" });
            } catch (error) {
              await markClarificationHookCleanupStep(clarification.id, {
                status: "failed",
                error: errorMessage(error),
              });
            }
          }
          return answered.answer;
        } catch (error) {
          await supersedeClarificationHookStep(clarification.id).catch(() => {});
          // A park that ends in a throw must not leave the row awaiting either.
          // Guarded on "awaiting", so this is a no-op for a failure raised
          // before the park and for a run a cancellation already flipped.
          await markRunResumedStep(workflowRunId).catch(() => {});
          throw error;
        } finally {
          hook.dispose();
        }
      };

      // The reviewer is waiting in a thread, and a failed run that says
      // nothing is indistinguishable from a webhook that never fired. Posted
      // before the ticket side effects and independent of them, because the
      // note belongs to the PR, not to the ticket.
      //
      // Only for runs a review comment started: a failed checks-fix run owes
      // the reviewer nothing, and a note about review threads on it would be
      // noise about work nobody asked for. A run that died before the feed
      // existed (clone, 401) still owes the reviewer the fact that it died,
      // so it gets a variant that claims to have seen no threads.
      const postReviewLedgerFailureNoteOnFailureExit = async (
        reason: string,
      ): Promise<void> => {
        if (
          ctx.entry.kind !== "pr_trigger" ||
          ctx.entry.triggerType !== "trigger_pr_review"
        ) {
          return;
        }
        // Flag off must reproduce byte-for-byte pre-ledger behavior, and the
        // pre-ledger run never posted a failure note on this path.
        const { env: modelEnv } = await import("./harness-profiles/model-env.js");
        if (!modelEnv.REVIEW_LEDGER_ENABLED) {
          return;
        }
        const ledger = ctx.reviewLedger;
        const workItems = ledger ? selectWorkItems(ledger.feed) : [];
        await postReviewLedgerFailureNoteStep({
          pr: {
            provider: ctx.entry.pr.provider,
            repoPath: ctx.entry.pr.repoPath,
            baseRef: ctx.entry.pr.baseRef,
            prNumber: ctx.entry.pr.prNumber,
          },
          runId: workflowRunId,
          reason,
          // Naming threads is only honest when the run had some to owe.
          unsettledAliases:
            ledger && workItems.length > 0
              ? unsettledWorkItemAliases(ledger, ctx.reviewLedgerSettled ?? [])
              : [],
          variant: ledger ? "threads" : "pre_feed",
          workItems: toLedgerGuardWorkItems(workItems),
          // Stamped by fix_agent after a successful push. A run that pushed
          // the fix and then lost the checks block owes the reviewer that
          // fact, or the note reads as "nothing happened".
          pushedHead: ctx.pushedHeadForPr ?? null,
          // Counted off what settlement actually wrote, so a run that answered
          // every thread before dying does not apologise for silence.
          answeredCount: settledAnswerCount(ctx.reviewLedgerSettled ?? []),
        }).catch(() => {});
      };

      const failureExit = async (
        phase: string,
        reason: string,
        _nodeId?: string,
        steps?: StepsRecord,
      ): Promise<void> => {
        // Commit the run's "failed" status BEFORE the backlog move below fires a
        // Jira webhook. That self-triggered "ticket left the AI column" event
        // would otherwise race in and cancel this still-finalizing run,
        // overwriting a genuine failure with a "cancelled"/"blocked" status the
        // errors KPI never counts. The cron never downgrades a frozen status, so
        // recording "failed" first keeps the outcome correct even if the cancel
        // still lands.
        await markRunFailedOnSelfMoveStep(workflowRunId);
        // Record why before the backlog move: the move fires the webhook that
        // cancels this run, and that cancellation writes its own generic reason.
        await recordRunFailureReasonStep(workflowRunId, reason);
        const usageReport = usageReportOrUndefined();
        const knownPhase = FAILURE_PHASES.has(phase) ? (phase as NotifyPhase) : undefined;
        await postReviewLedgerFailureNoteOnFailureExit(reason);
        // The ticket comment, and only the ticket comment, carries the script
        // evidence beside the reason. The run header, the run list and Slack
        // keep the reason alone: they read one bounded string each and AIW-254
        // pins them to the same one.
        const comment = repositoryScriptsFailureComment(
          reason,
          steps && isRepositoryScriptsFailurePhase(phase)
            ? recoverLatestRepositoryScriptsFailureFromSteps(steps)
            : null,
          {
            repairCyclesRequested: definitionRequestsRepairCycles(plan.nodes),
            // A gate the definition can never mint is a build error, not a run
            // error, and no other surface says so. run_scripts records no gate
            // on purpose, so a graph made only of it fails here every time.
            // Either refusal reaches here: the boundary names the missing
            // record when there is nothing else to say, and the scripts' own
            // verdict when there is. Both are the publication boundary refusing
            // a run with no gate, and a definition that can never mint one is
            // the same build error under either sentence.
            noGateBlock:
              (reason.includes(WORKSPACE_GATE_NOT_RECORDED_PREFIX) ||
                isRepositoryScriptsRefusal(reason)) &&
              !plan.nodes.some(nodeCanRecordGate),
            // Drift survives a run whose scripts all passed: a group with
            // restoreTree false leaves files behind and the boundary then
            // refuses to publish, with no failure entry anywhere to hang the
            // paths on.
            ...(steps ? { drift: recoverScriptDriftFromSteps(steps) } : {}),
            // From the context, not from the steps: the prepare block fails
            // before it can publish an output, so the failure it composed is
            // the only place these ever existed.
            ...(ctx.setupFailures?.length
              ? { setupFailures: ctx.setupFailures.map(repositoryScriptFailureEntry) }
              : {}),
          },
        );
        const { handleWorkflowFailureExit } = await import("./runtime/workflow-failure-exit.js");
        await handleWorkflowFailureExit(entry.ticketKey ?? undefined, {
          logFailure: () => logPhaseFailure(entry.subjectKey, phase, reason),
          commentFailure: () =>
            postFailureReasonCommentStep(ticket.identifier, comment, transitionOwner),
          moveTicket: () =>
            moveTicketStep(ticketId, backlogMoveTarget(), transitionOwner),
          notifyTicket: () => notifyTicket(ticket.identifier, {
            kind: "failed",
            ...(knownPhase ? { phase: knownPhase } : {}),
            reason,
            usageReport,
          }, transitionOwner),
        });
      };

      const noWorkspace = (type: WorkflowBlockType): BlockExecutionResult => ({
        ...executionError(`no workspace: connect prepare_workspace before ${type}`, {
          category: "sandbox",
        }),
      });

      const attachmentSandboxIds = new Set<string>();
      const writeAttachmentsOnce = async (sandboxId: string): Promise<void> => {
        if (attachmentSandboxIds.has(sandboxId)) return;
        await writeAttachments(sandboxId, downloadedAttachments);
        attachmentSandboxIds.add(sandboxId);
      };
      const materializedClarificationSignatures = new Map<string, string>();
      const materializeHumanDecisions = async (): Promise<void> => {
        if (!ctx.sandboxId || !ctx.clarifications?.length) return;
        const signature = JSON.stringify(ctx.clarifications);
        if (materializedClarificationSignatures.get(ctx.sandboxId) === signature) return;
        const { writeHumanDecisionsMemory } = await import(
          "./steps/write-human-decisions-memory.js"
        );
        await writeHumanDecisionsMemory(
          ctx.sandboxId,
          ctx.ticket.identifier,
          ctx.clarifications,
        );
        // The gate stays valid: this only writes an excluded, untracked file at
        // the agent's cwd, so neither HEAD nor the tracked tree the gate covers
        // can change.
        materializedClarificationSignatures.set(ctx.sandboxId, signature);
      };
      let repositorySelectionObserved = false;
      const discoverRepositories = async (
        discovery: NonNullable<EngineCtx["repositoryDiscovery"]>,
        execution?: BlockExecutionContext,
      ): Promise<
        | BlockExecutionResult
        | SelectedRepository[]
        | { repositories: SelectedRepository[]; sandboxId: string }
      > => {
        const phase = "repository-discovery";
        const label = "Repository discovery";
        const provisioned = await ensurePlanningAgentSandboxForBlock(
          ctx,
          ctx.runDefaultKind,
          defaultModel,
        );
        if (provisioned.kind === "execution_error") return provisioned;
        const sandboxId = provisioned.sandboxId;
        await writeAttachmentsOnce(sandboxId);
        const prepared = await prepareHarnessAgentInvocationStep(
          sandboxId,
          ctx.runDefaultKind,
          defaultModel,
          ctx.arthur.taskId,
        );
        if (!prepared.ok) return agentProtocolBlockError(prepared);
        const guard = await setCommitGuardStep(
          sandboxId,
          ctx.runDefaultKind,
          false,
        );
        if (!guard.ok) return agentProtocolBlockError(guard);

        const {
          REPOSITORY_DISCOVERY_SCHEMA,
          assembleRepositoryDiscoveryPrompt,
        } = await import("./repository-discovery/runner.js");
        const { paths, script } = await planPhaseStep(
          ctx.runDefaultKind,
          phase,
          defaultModel,
          REPOSITORY_DISCOVERY_SCHEMA,
        );
        const prompt = assembleRepositoryDiscoveryPrompt({
          ticket: ctx.ticket,
          discovery,
        });
        const launched = await writeAndStartPhase(
          sandboxId,
          ctx.runDefaultKind,
          phase,
          paths.input,
          prompt,
          paths.wrapper,
          script,
        );
        if (!launched.ok) return agentProtocolBlockError(launched.failure);
        ctx.markLaunched(label, execution?.attempt);
        const done = await pollPhaseUntilDone(
          sandboxId,
          paths.sentinel,
          5,
          launched.commandId,
          blockBudgetObserver(ctx, execution),
          execution?.cancellation,
        );
        if (!done) {
          return executionError("repository discovery timed out", {
            category: "timeout",
            phase,
          });
        }
        const artifacts = await collectPhase(sandboxId, paths);
        const parsed = await parseRepositoryDiscoveryStep(
          ctx.runDefaultKind,
          artifacts,
          phase,
          REPOSITORY_DISCOVERY_SCHEMA,
        );
        ctx.recordUsage(
          label,
          parsed.usage,
          { provider: ctx.runDefaultKind, model: defaultModel },
          execution?.attempt,
        );
        if (!parsed.result.ok) return agentProtocolBlockError(parsed.result);

        const { validateRepositoryDiscoveryResult } = await import(
          "./repository-discovery/protocol.js"
        );
        const decision = validateRepositoryDiscoveryResult(
          parsed.result.value,
          discovery.catalog,
          discovery.mandatoryRepositories,
        );
        if (decision.kind === "selected") {
          await emitRepositoryWorkflowObservation(execution?.observations, {
            event: "selection",
            source: "harness",
            catalogSize: discovery.catalog.length,
            selectedCount: decision.repositories.length,
            confidence: decision.confidence,
          });
          repositorySelectionObserved = true;
          return {
            repositories: decision.repositories,
            sandboxId,
          };
        }
        if (decision.kind === "clarification_needed") {
          return planningClarificationResult(decision.questions);
        }
        return executionError(decision.error, {
          category: "provider",
          phase,
        });
      };
      const expandResearchWorkspace = async (
        requests: NonNullable<ResearchResult["repositories"]>,
        execution?: BlockExecutionContext,
      ): Promise<BlockExecutionResult | null> => {
        // Defense-in-depth: a plan_approved run resumes a frozen approved scope,
        // so repository expansion must never widen it regardless of what the model
        // requests.
        if (ctx.entry.kind === "plan_approved") {
          return executionError(
            "repository expansion is not allowed: the repository scope is fixed by the approved plan",
            { category: "engine", phase: "research" },
          );
        }
        if (!ctx.sandboxId || ctx.workspaceManifest?.version !== 2) {
          return executionError(
            "repository expansion requires a trusted V2 research workspace",
            { category: "sandbox", phase: "research" },
          );
        }
        const { validateRepositoryExpansionRequests } = await import(
          "./repository-discovery/runner.js"
        );
        const decision = validateRepositoryExpansionRequests({
          requests,
          catalog: await listFreshRepositoryCatalogStep(
            ctx.repositories,
            ctx.repositoryScope,
          ),
          attached: ctx.selectedRepositories,
          completedRounds: ctx.repositoryExpansion.rounds,
        });
        if (decision.kind === "clarification_needed") {
          return planningClarificationResult(decision.questions);
        }
        if (
          decision.kind === "already_attached" ||
          decision.kind === "unnamed_request"
        ) {
          // Research either asked only for repositories the workspace already
          // holds, or asked for more context without naming a repository at
          // all: nothing to clone, and no question a human could usefully
          // answer, so continue with what is attached instead of parking the
          // run (AIW-284).
          // The round still counts and the requests are still recorded. That is
          // deliberate: it bounds a model that keeps re-requesting the same
          // repositories (the third round trips the expansion limit, which IS a
          // legitimate human question), and it puts the requests into the
          // "Repository expansion history" note the next research prompt carries,
          // which tells the model those repositories are attached and that it
          // should continue the same research.
          ctx.repositoryExpansion = {
            rounds: ctx.repositoryExpansion.rounds + 1,
            priorRequests: [
              ...ctx.repositoryExpansion.priorRequests,
              ...requests,
            ],
          };
          await emitRepositoryWorkflowObservation(execution?.observations, {
            event: "expansion",
            round: ctx.repositoryExpansion.rounds,
            attachedCount: 0,
            totalCount: ctx.selectedRepositories.length,
            cloneDurationMs: 0,
          });
          return null;
        }
        const attached = await attachResearchRepositoriesStep(
          ctx.sandboxId,
          ctx.workspaceManifest,
          decision.repositories,
          {
            subjectKey: ctx.entry.subjectKey,
            ownerToken: ctx.entry.ownerToken,
            runId: workflowRunId,
          },
          ctx.repositories,
          ctx.settings.JOB_TIMEOUT_MS,
        );
        const repositories = [
          ...ctx.selectedRepositories,
          ...decision.repositories,
        ];
        const { blockFetchPrContextsStep } = await import(
          "./blocks/fetch-pr-context/execute.js"
        );
        ctx.workspaceManifest = attached.manifest;
        ctx.selectedRepositories = repositories;
        ctx.repositoryContexts = await blockFetchPrContextsStep(
          repositories,
          ctx.repositories,
        );
        ctx.repositoryExpansion = {
          rounds: ctx.repositoryExpansion.rounds + 1,
          priorRequests: [
            ...ctx.repositoryExpansion.priorRequests,
            ...requests,
          ],
        };
        await emitRepositoryWorkflowObservation(execution?.observations, {
          event: "expansion",
          round: ctx.repositoryExpansion.rounds,
          attachedCount: decision.repositories.length,
          totalCount: repositories.length,
          cloneDurationMs: attached.cloneDurationMs,
        });
        return null;
      };
      const hydrateDiscoveredWorkspace = async (
        sandboxId: string,
        repositories: WorkspaceRepositoryInput[],
      ): Promise<Extract<WorkspaceManifest, { version: 2 }>> => {
        const attached = await attachResearchRepositoriesStep(
          sandboxId,
          { version: 2, repositories: [] },
          repositories,
          {
            subjectKey: ctx.entry.subjectKey,
            ownerToken: ctx.entry.ownerToken,
            runId: workflowRunId,
          },
          ctx.repositories,
          ctx.settings.JOB_TIMEOUT_MS,
        );
        return attached.manifest;
      };
      const ensureCodeWorkspace = async (
        execution?: BlockExecutionContext,
        options: { requireWrite?: boolean } = {},
      ): Promise<
        | { kind: "ready"; sandboxId: string }
        | { kind: "exit"; result: BlockExecutionResult }
      > => {
        const result = await ensureWorkspace(ctx, execution, {
          discoverRepositories: (discovery) =>
            discoverRepositories(discovery, execution),
          hydrateDiscoveredWorkspace,
        });
        if (result.kind !== "next") {
          if (
            ctx.entry.kind === "plan_approved" &&
            result.kind === "execution_error"
          ) {
            await emitRepositoryWorkflowObservation(execution?.observations, {
              event: "approval_stale",
              reason: "scope_validation_failed",
            });
          }
          return { kind: "exit", result };
        }
        if (!ctx.sandboxId) return { kind: "exit", result: noWorkspace("prepare_workspace") };
        if (!repositorySelectionObserved) {
          const narrowing = ctx.repositoryScopeNarrowing;
          await emitRepositoryWorkflowObservation(execution?.observations, {
            event: "selection",
            source:
              ctx.entry.kind === "plan_approved"
                ? "approved"
                : ctx.entry.kind === "pr_trigger"
                  ? "pr_trigger"
                  : (ctx.repositoryScope?.repositories?.length ?? 0) > 0
                    ? "definition_pin"
                    : "metadata",
            catalogSize:
              narrowing?.catalogSize ??
              ctx.repositoryDiscovery?.catalog.length ??
              ctx.selectedRepositories.length,
            selectedCount: ctx.selectedRepositories.length,
            ...(narrowing ? { scopedCatalogSize: narrowing.scopedCatalogSize } : {}),
          });
          repositorySelectionObserved = true;
        }
        if (
          ctx.entry.kind === "plan_approved" &&
          ctx.workspaceManifest?.version === 2
        ) {
          const approvedManifest = ctx.workspaceManifest;
          const writeRepositories =
            ctx.entry.approvedPlan.repositoryScope?.repositories
              .filter((repository) => repository.access === "write")
              .map((repository) => ({
                provider: repository.provider,
                repoPath: repository.repoPath,
                rationale: repository.rationale,
              })) ??
            ctx.selectedRepositories.map((repository) => ({
              provider: repository.provider,
              repoPath: repository.repoPath,
              rationale: repository.selectedRationale,
            }));
          const alreadyPromoted = writeRepositories.every((requested) =>
            approvedManifest.repositories.some(
              (repository) =>
                repository.access === "write" &&
                repository.provider === requested.provider &&
                repository.repoPath.toLowerCase() === requested.repoPath.toLowerCase(),
            ),
          );
          if (!alreadyPromoted) {
            const promotion = await promoteWorkspaceWrites(
              ctx,
              writeRepositories,
              execution,
            );
            if (promotion) return { kind: "exit", result: promotion };
          }
          ctx.researchWriteRepositories = writeRepositories;
        }
        // A code-writing block (implementation_agent) on a ticket graph without a
        // planning node never reaches the post-research promotion above, so promote
        // its all-read workspace here. Read-only callers (planning_agent, review_agent)
        // pass no requireWrite flag and keep research untouched.
        if (options.requireWrite) {
          const promotion = await maybePromoteTicketWorkspaceWrites(ctx, execution);
          if (promotion) return { kind: "exit", result: promotion };
          // Planning graph whose research declared no write set: the workspace is
          // still all-read and there is nothing to implement. Fail loud and early
          // instead of committing on a read-only checkout and dying at publication.
          const noWritesGuard = researchDeclaredNoWritesGuard(ctx);
          if (noWritesGuard) return { kind: "exit", result: noWritesGuard };
        }
        await writeAttachmentsOnce(ctx.sandboxId);
        await materializeHumanDecisions();
        return { kind: "ready", sandboxId: ctx.sandboxId };
      };

      const executeBlock: BlockExecutor = async (
        rawNode,
        steps,
        resolvedInputs,
        execution,
      ): Promise<BlockExecutionResult> => {
        const invocationAttempt = execution?.attempt ?? state.attempt;
        // Refresh {{change_summary}} from the implementation block's durable
        // output before substituting, so open_pr's description reflects what the
        // agent changed even on a resumed run where the impl case was skipped.
        ctx.changeSummary = implementationChangeSummary(steps, ctx.definitionNodes);
        // Substitute {{variables}} into prompt-bearing params per execution: the
        // run context (research plan, publication, selected repos) mutates
        // mid-run, so each block sees the values current at its turn.
        const node = rawNode;
        await materializeHumanDecisions();
        if (
          node.type === "implementation_agent" ||
          node.type === "fix_agent" ||
          node.type === "run_pre_pr_checks" ||
          (node.type === "generic_agent" && node.params.workspaceMode !== "none")
        ) {
          invalidateWorkspaceGate(ctx);
          ctx.reviewSourceFingerprints?.clear();
        }
        // A workspace-enabled generic_agent reuses whatever prepare_workspace
        // attached without routing through a write-ensuring path, so promote its
        // workspace here. The guard no-ops for every other block type, pr_trigger,
        // planning graphs, already-write manifests, and workspace-free generics.
        const genericPromotion = await maybePromoteGenericAgentWorkspace(
          ctx,
          node,
          execution,
        );
        if (genericPromotion) return genericPromotion;
        const blockExecute = BLOCK_EXECUTORS[node.type];
        if (blockExecute) {
          const result = await blockExecute(
            node,
            steps,
            ctx,
            resolvedInputs,
            execution,
          );
          if (node.type === "prepare_workspace" && result.kind === "next" && ctx.sandboxId) {
            activeModel ??= defaultModel;
            await writeAttachmentsOnce(ctx.sandboxId);
            await materializeHumanDecisions();
          }
          prForTelemetry ??= publicationPrForTelemetry(ctx.publication);
          prsForTelemetry ??= publicationPrsForTelemetry(ctx.publication);
          return result;
        }

        switch (node.type) {
          case "prepare_workspace": {
            const result = await ensureWorkspace(ctx, execution, {
              discoverRepositories: (discovery) =>
                discoverRepositories(discovery, execution),
              hydrateDiscoveredWorkspace,
            });
            if (result.kind === "next" && ctx.sandboxId) {
              activeModel ??= defaultModel;
              await writeAttachmentsOnce(ctx.sandboxId);
              await materializeHumanDecisions();
            }
            return result;
          }

          case "planning_agent": {
            // One retry per run, shared by both gates: the ledger's correction
            // note and the pre-ledger "do not declare this resolved" note ride
            // the same flag, so a run can never spend two research passes on
            // the same refusal and the -no-change-retry phase suffix stays
            // unique.
            let noChangeRetryUsed = false;
            let ledgerCorrectionNote: string | null = null;
            for (;;) {
            // AIW-147 IM-11: a human answer to the expansion-limit clarification
            // attaches the repositories it named beyond the model round limit
            // BEFORE research runs again, so the answer is actionable instead of
            // ping-ponging the same limit. Running before research also keeps the
            // research phase key fresh (this attach never counts a model round),
            // so the re-run reflects the newly attached repositories.
            const humanExpansion = await applyHumanRepositoryExpansion(ctx, {
              resolve: (answer, attached) =>
                resolveHumanRepositoryExpansionStep(
                  answer,
                  attached,
                  ctx.repositories,
                  ctx.repositoryScope,
                ),
              attach: (repositories) => {
                if (!ctx.sandboxId || ctx.workspaceManifest?.version !== 2) {
                  throw new Error(
                    "human repository expansion requires a trusted V2 workspace",
                  );
                }
                return attachResearchRepositoriesStep(
                  ctx.sandboxId,
                  ctx.workspaceManifest,
                  repositories,
                  {
                    subjectKey: ctx.entry.subjectKey,
                    ownerToken: ctx.entry.ownerToken,
                    runId: workflowRunId,
                  },
                  ctx.repositories,
                  ctx.settings.JOB_TIMEOUT_MS,
                );
              },
              fetchContexts: async (repositories) => {
                const { blockFetchPrContextsStep } = await import(
                  "./blocks/fetch-pr-context/execute.js"
                );
                return blockFetchPrContextsStep(repositories, ctx.repositories);
              },
            });
            if (humanExpansion.kind === "clarification") {
              return planningClarificationResult(humanExpansion.questions);
            }
            if (humanExpansion.kind === "attached") {
              await emitRepositoryWorkflowObservation(execution?.observations, {
                event: "expansion",
                round: ctx.repositoryExpansion.rounds,
                attachedCount: humanExpansion.repositories.length,
                totalCount: ctx.selectedRepositories.length,
                cloneDurationMs: humanExpansion.cloneDurationMs,
              });
              continue;
            }
            const expansionRound = ctx.repositoryExpansion.rounds;
            // The retry re-runs the research phase, so both the label and the
            // artifact phase must stay distinct from the first pass (same
            // freshness trick as the -expansion-N suffix).
            const noChangeRetrySuffix = noChangeRetryUsed ? " no-change retry" : "";
            const researchLabel = `Research ${node.id}${expansionRound > 0 ? ` expansion ${expansionRound}` : ""}${noChangeRetrySuffix}`;
            const baseResearchArtifactPhase = agentArtifactPhase("research", execution);
            const expandedResearchArtifactPhase =
              expansionRound > 0
                ? `${baseResearchArtifactPhase}-expansion-${expansionRound}`
                : baseResearchArtifactPhase;
            const researchArtifactPhase = noChangeRetryUsed
              ? `${expandedResearchArtifactPhase}-no-change-retry`
              : expandedResearchArtifactPhase;
            const researchPhase = phaseKey(researchLabel, invocationAttempt);
            const { kind, model, runtime } = resolveAgentForNode(node);
            const workspace = await ensureCodeWorkspace(execution);
            if (workspace.kind === "exit") return workspace.result;
            const sandboxId = workspace.sandboxId;
            await writeAttachmentsOnce(sandboxId);
            phaseModels[researchPhase] = model;
            phaseProviders[researchPhase] = kind;
            runPhaseModels[researchPhase] = model;
            runPhaseProviders[researchPhase] = kind;
            const researchRuntime = await prepareHarnessAgentInvocationStep(
              sandboxId,
              kind,
              model,
              ctx.arthur.taskId,
              runtime,
            );
            if (!researchRuntime.ok) {
              return agentProtocolBlockError(researchRuntime);
            }
            const researchGuard = await setCommitGuardStep(
              sandboxId,
              kind,
              false,
              runtime,
            );
            if (!researchGuard.ok) return agentProtocolBlockError(researchGuard);

            // Review-remediation framing: when this ticket already has a
            // workflow-owned PR, pull its human review feedback in BEFORE the
            // plan exists so the plan targets the requested changes. Workspace
            // prep refreshes this later; here it would otherwise be empty
            // because planning runs before any code workspace is provisioned.
            if (ctx.entry.kind === "ticket" && ctx.repositoryContexts.length === 0) {
              const { resolveTicketWorkflowOwnedReposStep, blockFetchPrContextsStep } =
                await import("./blocks/fetch-pr-context/execute.js");
              const ownedRepos = await resolveTicketWorkflowOwnedReposStep(ctx.ticket.identifier);
              if (ownedRepos.length > 0) {
                ctx.repositoryContexts = await blockFetchPrContextsStep(
                  ownedRepos,
                  ctx.repositories,
                );
              }
            }

            const { paths: researchPaths, script: researchScript } =
              await planPhaseStep(
                kind,
                researchArtifactPhase,
                model,
                RESEARCH_SCHEMA,
                runtime,
              );
            const researchAdditions = [...ctx.preSandboxAdditions.research];
            if (ctx.repositoryExpansion.priorRequests.length > 0) {
              researchAdditions.push({
                target: ["research" as const],
                title: "Repository expansion history",
                content: [
                  "The following repositories were requested and are now attached.",
                  "Continue the same research; do not restart from assumptions.",
                  JSON.stringify(ctx.repositoryExpansion.priorRequests),
                ].join("\n"),
              });
            }
            if (ledgerCorrectionNote) {
              // The ledger rejected specific aliases, so the generic "do not
              // declare this resolved" note would be misleading: the model is
              // told which claims failed and why instead.
              researchAdditions.push({
                target: ["research" as const],
                title: "Fix the rejected review thread dispositions",
                content: ledgerCorrectionNote,
              });
            } else if (noChangeRetryUsed) {
              researchAdditions.push({
                target: ["research" as const],
                title: "Do not declare this ticket already resolved",
                content: [
                  "A human requested changes in the PR review feedback above, and the previous research pass wrongly concluded no change was needed.",
                  "Treat addressing every point of that review feedback as the task: produce an implementation plan for it, declare the writeRepositories it touches, and do not set noChangeNeeded.",
                ].join("\n"),
              });
            }
            const researchContext = {
              ticket: resolveAgentTicketInput(resolvedInputs, ticketData, ctx.clarifications),
              branchName,
              attachments: downloadedAttachments,
              preSandboxAdditions: researchAdditions,
              repositoryContexts: ctx.repositoryContexts,
              workspaceManifest: ctx.workspaceManifest ?? undefined,
            };
            const resolvedResearchInput = await resolveAgentInput({
              compileEffectivePrompt: execution?.compileEffectivePrompt,
              blockPrompt: promptOverride(node) ?? "",
              runtimeData: assembleResearchPlanContext({
                ...researchContext,
                prompt: "",
              }),
              sandboxId,
              fallbackInput: assembleResearchPlanContext({
                ...researchContext,
                prompt: promptOverride(node) ?? prompts.research,
              }),
            });
            if (!resolvedResearchInput.ok) return resolvedResearchInput.result;
            const researchInput = resolvedResearchInput.input;

            const researchLaunch = await writeAndStartPhase(
              sandboxId, kind, researchArtifactPhase,
              researchPaths.input, researchInput,
              researchPaths.wrapper, researchScript,
              runtime,
            );
            if (!researchLaunch.ok) return agentProtocolBlockError(researchLaunch.failure);
            const researchCommandId = researchLaunch.commandId;
            launchedPhases.add(researchPhase);

            const researchDone = await pollPhaseUntilDone(
              sandboxId,
              researchPaths.sentinel,
              20,
              researchCommandId,
              blockBudgetObserver(ctx, execution),
              execution?.cancellation,
            );
            if (!researchDone) {
              await emitTimedOutAgentInvocationObservations({
                observations: execution?.observations,
                provider: kind,
                model,
                phase: researchArtifactPhase,
                collectArtifacts: () =>
                  collectPhaseReplayDiagnostics(
                    sandboxId,
                    researchPaths,
                  ),
              });
              return executionError("phase timed out", {
                category: "timeout",
                phase: "research",
              });
            }

            const researchArtifacts = await collectPhase(sandboxId, researchPaths);
            const { result: researchResult, usage: researchUsage } =
              await parseResearchStep(
                kind,
                researchArtifacts,
                researchArtifactPhase,
                runtime,
              );
            const researchClarificationDecision = execution?.observations && researchResult.ok
              ? await resolveClarificationDecisionObservation({
                  status: researchResult.value.status,
                  questions: researchResult.value.questions,
                  suggestedAnswers: researchResult.value.suggestedAnswers,
                  ticketValue: researchContext.ticket,
                  contextValue: researchContext.repositoryContexts,
                  harnessProfileHash: runtime?.manifestHash ?? null,
                })
              : undefined;
            await emitAgentInvocationObservations({
              observations: execution?.observations,
              provider: kind,
              model,
              phase: researchArtifactPhase,
              artifacts: researchArtifacts,
              usage: researchUsage,
              result: researchResult,
              ...(researchClarificationDecision
                ? { clarificationDecision: researchClarificationDecision }
                : {}),
            });
            recordBlockPhaseUsage(
              ctx,
              researchLabel,
              researchUsage,
              kind,
              model,
              execution,
            );
            if (!researchResult.ok) return agentProtocolBlockError(researchResult);
            const research = researchResult.value;

            if (research.status === "repositories_needed") {
              const expansion = await expandResearchWorkspace(
                research.repositories ?? [],
                execution,
              );
              if (expansion) return expansion;
              continue;
            }

            if (research.status === "clarification_needed") {
              // Prefer the structured questions the parser now folds out; fall
              // back to the legacy regex split of the freeform body for older
              // agent outputs that only populate research.body.
              let questions: string[];
              if (research.questions && research.questions.length > 0) {
                questions = research.questions;
              } else {
                const parsed = research.body.split("\n").filter((l) => /^\d+\./.test(l.trim()));
                questions = parsed.length > 0 ? parsed : [research.body];
              }
              const suggestedAnswers = research.suggestedAnswers;
              return planningClarificationResult(questions, suggestedAnswers);
            }

            if (research.status === "failed") {
              const reason = research.body.slice(0, 200);
              return executionError(reason, {
                category: "unknown",
                phase: "research",
              });
            }

            // An already resolved ticket (fix landed in an earlier commit, PR,
            // or ticket comment) ends the run here as a successful no-op: there
            // is nothing for any downstream block to write. A half-filled
            // signal keeps the normal plan path and its
            // researchDeclaredNoWritesGuard verdict untouched. When the
            // ticket's own PR carries human review feedback, that request is
            // the task, so the exit is refused: one corrective research retry,
            // then a hard fail instead of a false success.
            // With open review threads the ledger decides instead: a run is a
            // no-op only when every thread was answered and none of the answers
            // asks for code. Absent ledger (flag off, no PR run, or a feed with
            // nothing to answer) leaves the pre-ledger decision untouched.
            const ledgerRepoPath = reviewLedgerRepoLocalPath(ctx);
            const ledgerGate = ctx.reviewLedger
              ? await applyReviewLedgerGate(
                  {
                    ledger: ctx.reviewLedger,
                    dispositions: toReviewThreadDispositions(research.reviewThreads),
                    declaresWrites: (research.writeRepositories ?? []).length > 0,
                    retryUsed: noChangeRetryUsed,
                    reviewDriven:
                      ctx.entry.kind === "pr_trigger" &&
                      ctx.entry.triggerType === "trigger_pr_review",
                  },
                  {
                    readFile: (filePath) =>
                      ledgerRepoPath
                        ? readLedgerEvidenceFileStep(sandboxId, ledgerRepoPath, filePath)
                        : Promise.resolve(null),
                    settle: () => settleReviewLedgerThreads(ctx, null),
                    log: (metrics) => console.log(JSON.stringify(metrics)),
                  },
                )
              : null;
            if (ledgerGate?.kind === "retry") {
              ledgerCorrectionNote = ledgerGate.correctionNote;
              noChangeRetryUsed = true;
              continue;
            }
            if (ledgerGate?.kind === "fail") {
              return executionError(ledgerGate.reason, {
                category: "engine",
                phase: "research",
              });
            }
            if (ledgerGate?.kind === "no_change") {
              ctx.reviewLedgerSettled = ledgerGate.settled;
            }
            const noChangeAction = ledgerGate
              ? ledgerGate.kind === "no_change"
                ? "no_change"
                : "proceed"
              : resolveNoChangeAction(
                  research,
                  // With a ledger in play it is the only definition of pending
                  // feedback. The flat comment list still holds every note on
                  // the PR, including ones already answered, so letting it vote
                  // here would refuse a legitimate no-op forever.
                  ctx.reviewLedger ? [] : ctx.repositoryContexts,
                  noChangeRetryUsed,
                );
            if (noChangeAction === "retry") {
              console.warn(
                "[agent] research declared no_change_needed despite pending PR review feedback; retrying research once with a corrective note",
              );
              noChangeRetryUsed = true;
              continue;
            }
            if (noChangeAction === "fail") {
              return executionError(
                "research declared no change needed but the ticket's PR has unresolved human review feedback; refusing the no_change_needed exit",
                { category: "engine", phase: "research" },
              );
            }
            if (noChangeAction === "no_change") {
              const researchTotals = computeUsageTotals(
                runPhaseUsages,
                runPhaseProviders,
                priceLookup,
                activeModel,
                runPhaseModels,
              );
              ctx.analysisRevision += 1;
              ctx.analysisReport = buildResearchAnalysisReportBestEffort({
                runId: workflowRunId,
                researchRevision: ctx.analysisRevision,
                workspaceManifest: ctx.workspaceManifest,
                selectedRepositories: ctx.selectedRepositories,
                repositoryExpansion: ctx.repositoryExpansion,
                researchResult: research,
                usage: researchTotals,
                jiraApplicable: Boolean(entry.ticketKey),
                noChangeNeededOverride: true,
              });
              const analysisReportPersisted = ctx.analysisReport
                ? await recordRunAnalysisReportBestEffort(ctx.analysisReport)
                : false;
              // Ticket-bound side effects only, exactly like the terminate
              // dispatch: an uncorrelated entry has no ticket to comment on,
              // move, or notify about.
              if (entry.ticketKey) {
                let evidenceCommentUrl: string | null = null;
                if (ctx.analysisReport && analysisReportPersisted) {
                  let delivery: import("@shared/contracts").RunAnalysisCommentDelivery;
                  try {
                    delivery = await postRunAnalysisCommentStep(
                      ticket.identifier,
                      ctx.analysisReport,
                      "research",
                      transitionOwner,
                    );
                  } catch (error) {
                    if (isRunControlError(error)) throw error;
                    const deliveryError = safeRunAnalysisDeliveryError(error);
                    await recordRunAnalysisCommentFailureBestEffort(
                      ctx.analysisReport.runId,
                      "research",
                      deliveryError,
                    );
                    delivery = {
                      state: "failed",
                      attemptedAt: new Date().toISOString(),
                      commentUrl: null,
                      error: deliveryError,
                    };
                  }
                  ctx.analysisReport = withAnalysisDelivery(ctx.analysisReport, "no_change", delivery);
                  await recordRunAnalysisReportBestEffort(ctx.analysisReport);
                  evidenceCommentUrl = delivery.commentUrl;
                } else {
                  evidenceCommentUrl = await postTicketComment(
                    ticket.identifier,
                    ledgerGate?.kind === "no_change"
                      ? ledgerGate.comment
                      : buildResolutionEvidenceComment(research),
                    transitionOwner,
                  );
                }
                // terminal_success skips the downstream cone, so the graph's own
                // update_ticket_status node never runs. Dispatch has no
                // post-success dedup: a ticket left in the AI column would be
                // redispatched, so replay that node's configured move here.
                // Graphs without such a node do not move on normal success
                // either, so they do not move here. Only for a run the column
                // dispatched: see entryNeedsTicketStatusReplay.
                const statusNode = entryNeedsTicketStatusReplay(entry)
                  ? ctx.definitionNodes.find(
                      (candidate) => candidate.type === "update_ticket_status",
                    )
                  : undefined;
                if (statusNode) {
                  const targetName = resolveTicketStatusInput(statusNode.params, {});
                  const target = resolveTicketMoveTarget(targetName, {
                    backlog: backlogMoveTarget(),
                    aiReview: aiReviewMoveTarget(),
                  });
                  // Same self-move race as the real block: commit the run's
                  // success before the move fires the "ticket left the AI
                  // column" webhook.
                  if (targetName === "ai_review") {
                    await markRunSucceededOnSelfMoveStep(workflowRunId);
                  }
                  await moveTicketStep(entry.ticketKey, target, transitionOwner);
                }
                const note =
                  ledgerGate?.kind === "no_change"
                    ? // "Answered" only when something really was answered: a
                      // run whose threads all wait on a human replied to none.
                      (ctx.reviewLedger?.verification?.accepted.length ?? 0) > 0
                      ? "Answered the open review threads, no code changes needed."
                      : "No open review thread needed an answer, no code changes made."
                    : "Ticket already resolved, no code changes needed.";
                await notifyTicket(
                  ticket.identifier,
                  {
                    kind: "note",
                    text: evidenceCommentUrl
                      ? `${note} Evidence: ${evidenceCommentUrl}`
                      : note,
                  },
                  transitionOwner,
                );
              }
              return {
                kind: "terminal_success",
                output: {
                  status: "no_change_needed",
                  plan: research.body,
                  evidence: research.resolutionEvidence ?? [],
                  ...(ledgerGate?.kind === "no_change"
                    ? { reviewLedgerSettled: ledgerGate.settled }
                    : {}),
                },
              };
            }

            ctx.researchWriteRepositories = research.writeRepositories ?? [];
            const researchWorkspaceManifest = ctx.workspaceManifest;
            if (
              shouldPromoteResearchWriteScope({
                definitionNodes: ctx.definitionNodes,
                writeRepositories: ctx.researchWriteRepositories,
                manifestVersion: ctx.workspaceManifest?.version,
              })
            ) {
              const promotion = await promoteWorkspaceWrites(
                ctx,
                ctx.researchWriteRepositories,
                execution,
              );
              if (promotion) return promotion;
            }
            ctx.researchPlanMarkdown = research.body;
            const researchTotals = computeUsageTotals(
              runPhaseUsages,
              runPhaseProviders,
              priceLookup,
              activeModel,
              runPhaseModels,
            );
            ctx.analysisRevision += 1;
            ctx.analysisReport = buildResearchAnalysisReportBestEffort({
              runId: workflowRunId,
              researchRevision: ctx.analysisRevision,
              workspaceManifest: researchWorkspaceManifest,
              selectedRepositories: ctx.selectedRepositories,
              repositoryExpansion: ctx.repositoryExpansion,
              researchResult: research,
              usage: researchTotals,
              jiraApplicable: Boolean(entry.ticketKey),
            });
            const analysisReportPersisted = ctx.analysisReport
              ? await recordRunAnalysisReportBestEffort(ctx.analysisReport)
              : false;
            if (entry.ticketKey && ctx.analysisReport && analysisReportPersisted) {
              let delivery: import("@shared/contracts").RunAnalysisCommentDelivery;
              try {
                delivery = await postRunAnalysisCommentStep(
                  ticket.identifier,
                  ctx.analysisReport,
                  "research",
                  transitionOwner,
                );
              } catch (error) {
                if (isRunControlError(error)) throw error;
                const deliveryError = safeRunAnalysisDeliveryError(error);
                await recordRunAnalysisCommentFailureBestEffort(
                  ctx.analysisReport.runId,
                  "research",
                  deliveryError,
                );
                delivery = {
                  state: "failed",
                  attemptedAt: new Date().toISOString(),
                  commentUrl: null,
                  error: deliveryError,
                };
              }
              ctx.analysisReport = withAnalysisDelivery(ctx.analysisReport, "research_complete", delivery);
              await recordRunAnalysisReportBestEffort(ctx.analysisReport);
            }
            return {
              kind: "next",
              output: {
                status: "ready",
                plan: research.body,
                ...reviewLedgerOutputFields(ctx),
              },
            };
            }
          }
          // falls through

          case "implementation_agent": {
            const workspace = await ensureCodeWorkspace(execution, {
              requireWrite: true,
            });
            if (workspace.kind === "exit") return workspace.result;
            const sandboxId = workspace.sandboxId;
            const implementationLabel = `Impl ${node.id}`;
            const implementationArtifactPhase = agentArtifactPhase("impl", execution);
            const implPhase = phaseKey(
              implementationLabel,
              invocationAttempt,
            );
            const { kind, model, runtime } = resolveAgentForNode(node);
            phaseModels[implPhase] = model;
            phaseProviders[implPhase] = kind;
            runPhaseModels[implPhase] = model;
            runPhaseProviders[implPhase] = kind;
            state.implementationModel = model;
            state.implementationKind = kind;
            state.implementationRuntime = runtime;
            // Mixed-run telemetry: the run's headline model is the impl block's.
            activeModel = model;
            const implementationRuntime =
              await prepareHarnessAgentInvocationStep(
                sandboxId,
                kind,
                model,
                ctx.arthur.taskId,
                runtime,
              );
            if (!implementationRuntime.ok) {
              return agentProtocolBlockError(implementationRuntime);
            }
            const implementationGuard = await setCommitGuardStep(
              sandboxId,
              kind,
              true,
              runtime,
            );
            if (!implementationGuard.ok) return agentProtocolBlockError(implementationGuard);

            const { paths: implPaths, script: implScript } =
              await planPhaseStep(
                kind,
                implementationArtifactPhase,
                model,
                AGENT_SCHEMA,
                runtime,
              );
            const implementationContext = {
              ticket: resolveAgentTicketInput(resolvedInputs, ticketData, ctx.clarifications),
              researchPlanMarkdown: resolveImplementationPlanInput(
                resolvedInputs,
                ctx.researchPlanMarkdown,
              ),
              attachments: downloadedAttachments,
              preSandboxAdditions: ctx.preSandboxAdditions.implementation,
              selectedRepositories: ctx.selectedRepositories,
              repositoryContexts: ctx.repositoryContexts,
              workspaceManifest: ctx.workspaceManifest ?? undefined,
            };
            const resolvedImplementationInput = await resolveAgentInput({
              compileEffectivePrompt: execution?.compileEffectivePrompt,
              blockPrompt: promptOverride(node) ?? "",
              runtimeData: assembleImplementationContext({
                ...implementationContext,
                prompt: "",
              }),
              sandboxId,
              fallbackInput: assembleImplementationContext({
                ...implementationContext,
                prompt: promptOverride(node) ?? prompts.implement,
              }),
            });
            if (!resolvedImplementationInput.ok) {
              return resolvedImplementationInput.result;
            }
            const implInput = resolvedImplementationInput.input;

            const implLaunch = await writeAndStartPhase(
              sandboxId, kind, implementationArtifactPhase,
              implPaths.input, implInput,
              implPaths.wrapper, implScript,
              runtime,
            );
            if (!implLaunch.ok) return agentProtocolBlockError(implLaunch.failure);
            const implCommandId = implLaunch.commandId;
            launchedPhases.add(implPhase);

            const implDone = await pollPhaseUntilDone(
              sandboxId,
              implPaths.sentinel,
              35,
              implCommandId,
              blockBudgetObserver(ctx, execution),
              execution?.cancellation,
            );
            let implOutput: AgentOutput;

            if (implDone) {
              const implArtifacts = await collectPhase(sandboxId, implPaths);
              const { result, usage: implUsage } = await parseAgentOutputStep(
                kind,
                implArtifacts,
                implementationArtifactPhase,
                runtime,
              );
              const implClarificationDecision = execution?.observations && result.ok
                ? await resolveClarificationDecisionObservation({
                    status: result.value.result,
                    questions: result.value.questions,
                    suggestedAnswers: result.value.suggestedAnswers,
                    ticketValue: implementationContext.ticket,
                    contextValue: implementationContext.repositoryContexts,
                    harnessProfileHash: runtime?.manifestHash ?? null,
                  })
                : undefined;
              await emitAgentInvocationObservations({
                observations: execution?.observations,
                provider: kind,
                model,
                phase: implementationArtifactPhase,
                artifacts: implArtifacts,
                usage: implUsage,
                result,
                ...(implClarificationDecision
                  ? { clarificationDecision: implClarificationDecision }
                  : {}),
              });
              recordBlockPhaseUsage(
                ctx,
                implementationLabel,
                implUsage,
                kind,
                model,
                execution,
              );
              if (!result.ok) return agentProtocolBlockError(result);
              implOutput = result.value;
            } else {
              await emitTimedOutAgentInvocationObservations({
                observations: execution?.observations,
                provider: kind,
                model,
                phase: implementationArtifactPhase,
                collectArtifacts: () =>
                  collectPhaseReplayDiagnostics(sandboxId, implPaths),
              });
              implOutput = { result: "failed", error: "Implementation phase timed out" };
            }

            if (implOutput.result === "clarification_needed") {
              const questions = implOutput.questions ?? [];
              const suggestedAnswers = implOutput.suggestedAnswers;
              return {
                kind: "needs_human_input",
                output: { status: "needs_human_input", questions },
                questions,
                ...(suggestedAnswers && suggestedAnswers.length > 0 ? { suggestedAnswers } : {}),
              };
            }

            if (implOutput.result === "failed") {
              const reason = implOutput.error ?? "unknown";
              return executionError(reason, {
                category: implDone ? "unknown" : "timeout",
                phase: "impl",
              });
            }

            if (!ctx.workspaceManifest) {
              return executionError("implementation workspace manifest is unavailable", {
                category: "sandbox",
                phase: "impl",
              });
            }
            try {
              const { inspectFixWorkspace } = await import("./blocks/fix-workspace-state.js");
              const workspaceState = await inspectFixWorkspace(sandboxId);
              // Last point before finalize publishes: re-check the quotes the
              // planner promised against the tree this run actually produced.
              const ledgerRepoPath = reviewLedgerRepoLocalPath(ctx);
              await runLedgerEvidenceSecondPass(ctx.reviewLedger, (filePath) =>
                ledgerRepoPath
                  ? readLedgerEvidenceFileStep(sandboxId, ledgerRepoPath, filePath)
                  : Promise.resolve(null),
              );
              return {
                kind: "next",
                output: {
                  ...buildImplementationAgentSuccessOutput({
                    workspaceId: sandboxId,
                    workspaceManifest: ctx.workspaceManifest,
                    commits: workspaceState.commits,
                    summary: implOutput.summary,
                  }),
                  ...reviewLedgerOutputFields(ctx),
                },
              };
            } catch (error) {
              if (isRunControlError(error)) throw error;
              return executionError(
                `could not inspect implementation workspace: ${errorMessage(error)}`,
                { category: "sandbox", phase: "impl" },
              );
            }
          }

          case "review_agent": {
            const workspace = await ensureCodeWorkspace(execution);
            if (workspace.kind === "exit") return workspace.result;
            const reviewFeedback = resolveReviewFeedbackInput(resolvedInputs, {
              ambient: ctx.entry.kind === "pr_trigger" ? ctx.entry.pr.review : undefined,
              allowAmbientFallback: false,
            });
            if (!reviewFeedback.ok) {
              return executionError("invalid reviewFeedback binding", {
                category: "binding",
                message: reviewFeedback.message,
              });
            }
            const { kind, model, runtime } = resolveAgentForNode(node);
            if (!ctx.workspaceManifest) {
              return executionError("review source workspace manifest is unavailable", {
                category: "sandbox",
                phase: "review",
              });
            }
            const {
              provisionDisposableReviewWorkspaceStep,
              verifyDisposableReviewWorkspaceStep,
            } = await import("./steps/disposable-review-workspace.js");
            const provisioned = await provisionDisposableReviewWorkspaceStep({
              sourceSandboxId: workspace.sandboxId,
              workspaceManifest: ctx.workspaceManifest,
              subjectKey: ctx.entry.subjectKey,
              ownerToken: ctx.entry.ownerToken,
              agentKind: kind,
              model,
              arthurTaskId: ctx.arthur.taskId,
              jobTimeoutMs: ctx.settings.JOB_TIMEOUT_MS,
              runtime,
              // The session memory document lives outside the repository now, so
              // the bundles this review workspace is built from cannot carry it.
              memoryTaskId: ctx.ticket.identifier,
            });
            if (!provisioned.ok) {
              return agentProtocolBlockError(provisioned.failure);
            }
            const sandboxId = provisioned.sandboxId;
            ctx.sandboxIds.add(sandboxId);
            const reviewLabel = `Review ${node.id}`;
            const reviewArtifactPhase = agentArtifactPhase("review", execution);
            const reviewPhase = phaseKey(reviewLabel, invocationAttempt);
            phaseModels[reviewPhase] = model;
            phaseProviders[reviewPhase] = kind;
            runPhaseModels[reviewPhase] = model;
            runPhaseProviders[reviewPhase] = kind;
            try {
              {
                const activationScopeId =
                  execution?.activationScopeId ?? "root";
                const reviewSourceFingerprints =
                  (ctx.reviewSourceFingerprints ??= new Map<string, string>());
                const expectedFingerprint =
                  reviewSourceFingerprints.get(activationScopeId);
                if (
                  expectedFingerprint !== undefined &&
                  expectedFingerprint !== provisioned.sourceFingerprint
                ) {
                  return executionError(
                    "parallel reviews did not receive the same workspace snapshot",
                    {
                      category: "sandbox",
                      phase: "review",
                      message:
                        "Parallel reviews could not use one identical workspace snapshot.",
                    },
                  );
                }
                reviewSourceFingerprints.set(
                  activationScopeId,
                  provisioned.sourceFingerprint,
                );
              }
              const reviewRuntime = await prepareHarnessAgentInvocationStep(
                sandboxId,
                kind,
                model,
                ctx.arthur.taskId,
                runtime,
              );
              if (!reviewRuntime.ok) {
                return agentProtocolBlockError(reviewRuntime);
              }
              const reviewGuard = await setCommitGuardStep(
                sandboxId,
                kind,
                false,
                runtime,
              );
              if (!reviewGuard.ok) {
                return agentProtocolBlockError(reviewGuard);
              }
              const { paths: reviewPaths, script: reviewScript } =
                await planPhaseStep(
                  kind,
                  reviewArtifactPhase,
                  model,
                  REVIEW_SCHEMA,
                  runtime,
                );
              const reviewContext = {
                ticket: ticketData,
                researchPlanMarkdown: ctx.researchPlanMarkdown,
                ...(reviewFeedback.value
                  ? { reviewFeedback: reviewFeedback.value }
                  : {}),
                attachments: downloadedAttachments,
                preSandboxAdditions: ctx.preSandboxAdditions.review,
                selectedRepositories: ctx.selectedRepositories,
                workspaceManifest: ctx.workspaceManifest ?? undefined,
              };
              const resolvedReviewInput = await resolveAgentInput({
                compileEffectivePrompt: execution?.compileEffectivePrompt,
                blockPrompt: promptOverride(node) ?? "",
                runtimeData: assembleReviewContext({
                  ...reviewContext,
                  prompt: "",
                }),
                sandboxId,
                fallbackInput: assembleReviewContext({
                  ...reviewContext,
                  prompt: promptOverride(node) ?? prompts.review,
                }),
              });
              if (!resolvedReviewInput.ok) return resolvedReviewInput.result;
              const reviewInput = resolvedReviewInput.input;

              const reviewLaunch = await writeAndStartPhase(
                sandboxId, kind, reviewArtifactPhase,
                reviewPaths.input, reviewInput,
                reviewPaths.wrapper, reviewScript,
                runtime,
              );
              if (!reviewLaunch.ok) return agentProtocolBlockError(reviewLaunch.failure);
              const reviewCommandId = reviewLaunch.commandId;
              launchedPhases.add(reviewPhase);

              const reviewDone = await pollPhaseUntilDone(
                sandboxId,
                reviewPaths.sentinel,
                15,
                reviewCommandId,
                blockBudgetObserver(ctx, execution),
                execution?.cancellation,
              );
              if (!reviewDone) {
                await emitTimedOutAgentInvocationObservations({
                  observations: execution?.observations,
                  provider: kind,
                  model,
                  phase: reviewArtifactPhase,
                  collectArtifacts: () =>
                    collectPhaseReplayDiagnostics(
                      sandboxId,
                      reviewPaths,
                    ),
                });
                return executionError("Review phase timed out", {
                  category: "timeout",
                  phase: "review",
                });
              }

              const reviewArtifacts = await collectPhase(sandboxId, reviewPaths);
              const { result, usage: reviewUsage } = await parseReviewStep(
                kind,
                reviewArtifacts,
                reviewArtifactPhase,
                runtime,
              );
              await emitAgentInvocationObservations({
                observations: execution?.observations,
                provider: kind,
                model,
                phase: reviewArtifactPhase,
                artifacts: reviewArtifacts,
                usage: reviewUsage,
                result,
              });
              recordBlockPhaseUsage(
                ctx,
                reviewLabel,
                reviewUsage,
                kind,
                model,
                execution,
              );
              if (!result.ok) return agentProtocolBlockError(result);
              const reviewOutput: ReviewOutput = result.value;

              const verified = await verifyDisposableReviewWorkspaceStep(
                sandboxId,
                ctx.workspaceManifest,
                provisioned.repositories,
              );
              if (!verified.ok) {
                return executionError(verified.error, {
                  category: "sandbox",
                  phase: "review",
                  message: "The disposable review workspace failed its integrity check.",
                });
              }

              return reviewAgentExecutionResult(
                reviewOutput,
                ctx.workspaceManifest,
              );
            } finally {
              await teardownSandboxes([sandboxId]);
            }
          }

          case "run_pre_pr_checks": {
            if (!ctx.sandboxId) return noWorkspace(node.type);
            // node.params.maxFixCycles is deliberately not read. The repair loop
            // it bounded is gone: it hid failing checks behind an agent's edits
            // and could not tell a broken environment from broken code. The
            // parameter stays accepted by the schema so every definition
            // deployed with it keeps validating, and is ignored here.
            const repairRuntime =
              state.implementationRuntime ??
              ctx.definitionNodes
                .filter(
                  (candidate) =>
                    candidate.type === "implementation_agent" ||
                    candidate.type === "fix_agent" ||
                    (candidate.type === "generic_agent" &&
                      candidate.params.workspaceMode !== "none"),
                )
                .map((candidate) => ctx.harnessRuntimes[candidate.id])
                .find(
                  (candidate): candidate is ResolvedHarnessRuntime =>
                    candidate !== undefined,
                );
            const repairKind =
              repairRuntime?.manifest.harness.provider ??
              state.implementationKind ??
              runDefaultKind;
            const repairModel =
              repairRuntime?.manifest.model.id ??
              state.implementationModel;
            const budget = await ctx.observeBudget();
            if (budget.check.status !== "ok") throw new RunBudgetError(budget.check);
            // Loading the configuration is a step; running the checks is not.
            // They are launched detached and polled across ticks, because a
            // client tenant's real checks outlive the 300s one function
            // invocation gets and used to kill the run with no recoverable
            // cause. See workflows/blocks/pre-pr-checks.ts.
            const prePrConfig = await loadPrePrCheckConfigStep();
            let prePrChecks: PrePrCheckRunResult;
            try {
              prePrChecks = await runPrePrChecksWithFixes({
                sandboxId: ctx.sandboxId,
                config: prePrConfig.config,
                agentKind: repairKind,
                model: repairModel,
                defaultCommandTimeoutMinutes:
                  runSettings.PRE_PR_COMMAND_TIMEOUT_MINUTES,
                observeBudget: blockBudgetObserver(ctx, execution),
                observeChecksBudget: checksBudgetObserver(ctx, execution),
                ...checksCeilingOption(steps),
                cancellation: execution?.cancellation,
                ...(execution?.observations
                  ? { observations: execution.observations }
                  : {}),
                budget: {
                  state: budgetState,
                  limits: budgetLimits,
                  price: priceLookup?.(repairModel) ?? null,
                },
                runtime: repairRuntime,
                arthurTaskId: ctx.arthur.taskId,
              });
            } catch (err) {
              if (isRunControlError(err) || isChecksCeilingExceededError(err)) throw err;
              propagateInvocationInterruption(err);
              const after = await ctx.observeBudget(false, "checks");
              if (after.check.status !== "ok") throw new RunBudgetError(after.check);
              // Everything prePrChecksFailureMustPropagate covers has already
              // left through the two branches above, so what remains cannot
              // have an identity that wrapping destroys. It must still be
              // wrapped: the checks are no longer a step, so an unbounded,
              // unredacted throw would travel from workflow scope straight to
              // the operator, and before #316 that arrived as Workflow's own
              // "exceeded max retries" with no name, no message and nothing in
              // the runtime logs.
              throw new Error(await prePrChecksFailureMessage(err, prePrConfig.version), { cause: err });
            }
            recordPrePrFixCycleUsages(
              ctx,
              prePrChecks.fixCycleUsages,
              repairKind,
              repairModel,
              prePrChecks.budgetFailure,
              invocationAttempt,
              node.id,
            );
            if (prePrChecks.agentFailure) {
              return agentProtocolBlockError(prePrChecks.agentFailure);
            }
            const gateOutput = repositoryScriptsOutput(prePrChecks);
            if (!prePrChecks.passed) {
              return {
                kind: "next",
                output: {
                  status: repositoryScriptsStatus(gateOutput),
                  ...gateOutput,
                  // Always 0. Still emitted because definitions deployed against
                  // this contract bind steps.checks.output.fixCycles.
                  fixCycles: prePrChecks.fixCycles,
                },
              };
            }
            if (prePrConfig.version !== null && ctx.workspaceManifest) {
              ctx.prePrGate = await recordSuccessfulWorkspaceGate({
                sandboxId: ctx.sandboxId,
                workspaceManifest: ctx.workspaceManifest,
                configurationVersion: prePrConfig.version,
                // The versions these checks were LAUNCHED under, straight off
                // the configuration load above. No second read, so an edit that
                // landed while the checks ran is caught at Finalize instead of
                // being adopted here.
                ...(prePrConfig.repositoryVersions
                  ? { repositoryVersions: prePrConfig.repositoryVersions }
                  : {}),
              });
            }
            return {
              kind: "next",
              output: {
                status: repositoryScriptsStatus(gateOutput),
                ...gateOutput,
                fixCycles: prePrChecks.fixCycles,
                // Durably checkpoint the gate alongside the pass so finalize can
                // recover it when the ephemeral ctx.prePrGate is lost on a cold
                // scheduler resume. Same value just recorded to ctx.prePrGate;
                // spread into a plain JSON object for the BlockOutput contract.
                // recoverPrePrGateFromSteps keys on this outcome+gate pair, so
                // neither key may move.
                gate: serializeWorkspaceGate(ctx.prePrGate),
              },
            };
          }

          case "open_pr": {
            const repositories = resolvedInputs.repositories;
            if (!Array.isArray(repositories)) {
              return executionError(
                "Open PR/MR requires successful Finalize repository metadata",
                { category: "binding", phase: "open-pr" },
              );
            }
            // node.params.title/body are already {{var}}-substituted (executeBlock).
            // ticket.title is the last-resort title if a template resolves empty.
            const prVars = buildPromptVariables(ctx);
            const prTitle =
              resolveOpenPrTitle(node.params, resolvedInputs, prVars) || ticket.title;
            const prBody = resolveOpenPrBody(node.params, resolvedInputs, prVars);
            const publication = await openPullRequestsForPublication({
              repositories: repositories as import("./steps/workspace-publication.js").FinalizedBranch[],
              runId: ctx.runId,
              subjectKey: transitionOwner.subjectKey,
              ownerToken: transitionOwner.ownerToken,
              ticketKey: ticket.identifier,
              title: prTitle,
              body: prBody,
              repositoryAccess: ctx.repositories,
              sourcePullRequest:
                ctx.entry.kind === "pr_trigger"
                  ? {
                      provider: ctx.entry.pr.provider,
                      repoPath: ctx.entry.pr.repoPath,
                      prId: ctx.entry.pr.prNumber,
                      headSha: ctx.entry.pr.headSha,
                      baseRef: ctx.entry.pr.baseRef,
                    }
                  : undefined,
            });
            ctx.publication = publication;
            await emitRepositoryWorkflowObservation(execution?.observations, {
              event: "publication",
              prCount: publication.prs.length,
            });

            if (publication.status === "failed") {
              if (publication.prs.length > 0) {
                await postPrLinksComment(
                  ticket.identifier,
                  publication.prs,
                  transitionOwner,
                  "Pull requests created before publication failed:",
                );
              }
              return executionError(publication.reason, {
                // A repository the catalog withholds refuses inside the PR step
                // and surfaces as a publication failure; blaming the provider
                // for it is what sent operators to a forge status page.
                category: isRepositoryCatalogRefusal(publication.reason)
                  ? "configuration"
                  : "provider",
                phase: "open-pr",
              });
            }

            if (publication.status !== "published") {
              return executionError(
                `Open PR/MR received unexpected publication status: ${publication.status}`,
                { category: "engine", phase: "open-pr" },
              );
            }

            const hasNewPublication = publication.prs.some((pr) => pr.isNew);
            let publicationReport: RunAnalysisReport | null = null;
            let publicationReportPersisted = false;
            if (ctx.analysisReport) {
              try {
                publicationReport = withAnalysisPublication(
                  ctx.analysisReport,
                  publication,
                  ctx.changeSummary,
                  computeUsageTotals(
                    runPhaseUsages,
                    runPhaseProviders,
                    priceLookup,
                    activeModel,
                    runPhaseModels,
                  ),
                );
                ctx.analysisReport = publicationReport;
                publicationReportPersisted = await recordRunAnalysisReportBestEffort(publicationReport);
              } catch (error) {
                console.warn(
                  `[agent] publication analysis report unavailable: ${safeRunAnalysisReportError(error)}`,
                );
              }
              if (publicationReport && publicationReportPersisted && hasNewPublication && entry.ticketKey) {
                let delivery: import("@shared/contracts").RunAnalysisCommentDelivery;
                try {
                  delivery = await postRunAnalysisCommentStep(
                    ticket.identifier,
                    publicationReport,
                    "pull_request",
                    transitionOwner,
                  );
                } catch (error) {
                  if (isRunControlError(error)) throw error;
                  const deliveryError = safeRunAnalysisDeliveryError(error);
                  await recordRunAnalysisCommentFailureBestEffort(
                    publicationReport.runId,
                    "pull_request",
                    deliveryError,
                  );
                  delivery = {
                    state: "failed",
                    attemptedAt: new Date().toISOString(),
                    commentUrl: null,
                    error: deliveryError,
                  };
                }
                ctx.analysisReport = withAnalysisDelivery(publicationReport, "published", delivery);
                await recordRunAnalysisReportBestEffort(ctx.analysisReport);
              }
            }
            if ((!publicationReport || !publicationReportPersisted) && hasNewPublication) {
              await postPrLinksComment(ticket.identifier, publication.prs, transitionOwner);
            }

            const primaryPr = publication.prs[0]!;
            prForTelemetry = { url: primaryPr.url, number: primaryPr.id };
            prsForTelemetry = publicationPrsForTelemetry(publication);
            return { kind: "next", output: buildOpenPrSuccessOutput(publication.prs) };
          }

          case "send_slack_message": {
            // node.params.message is already {{variable}}-substituted (executeBlock).
            const message = resolveSlackMessageInput(node.params, resolvedInputs);
            const sendOn = node.params.sendOn === "always" ? "always" : "pr_ready";

            if (sendOn === "always") {
              // Standalone message: post it as a thread note whenever this block
              // runs, independent of any PR. Empty message is a no-op.
              if (!message) return { kind: "next", output: { status: "skipped" } };
              await notifyTicket(ticket.identifier, { kind: "note", text: message }, transitionOwner);
              return { kind: "next", output: { status: "ok" } };
            }

            // Default "pr_ready": ride along with the PR-ready card, only once a PR
            // has been published.
            const publication = ctx.publication;
            const publishedPrs = publicationPrsForTelemetry(publication);
            if (publication?.status === "published" && publishedPrs) {
              const usageReport = formatUsageReport(
                phaseUsages,
                phaseProviders,
                priceLookup,
                activeModel,
                phaseModels,
              );
              await notifyTicket(ticket.identifier, {
                kind: "pr_ready",
                prs: publishedPrs,
                usageReport,
                ...(message ? { extraText: message } : {}),
              }, transitionOwner);
              return { kind: "next", output: { status: "ok" } };
            }
            return { kind: "next", output: { status: "skipped" } };
          }

          case "update_ticket_status": {
            const targetName = resolveTicketStatusInput(node.params, resolvedInputs);
            const target = resolveTicketMoveTarget(targetName, {
              backlog: backlogMoveTarget(),
              aiReview: aiReviewMoveTarget(),
            });
            if (!entry.ticketKey) {
              throw new Error("Update Ticket Status requires a correlated ticket.");
            }
            // The "ai_review" move is the run's own successful completion.
            // Commit the run's "success" status BEFORE that move fires the
            // self-triggered "ticket left the AI column" webhook (same race as
            // failureExit): when the webhook's actor lookup transiently fails
            // it fails safe as a human move and would cancel this
            // still-finalizing run, recording a real success as "blocked".
            // Only the symbolic success target gets this; backlog or arbitrary
            // status moves are generic ticket moves, not a completion.
            if (targetName === "ai_review") {
              await markRunSucceededOnSelfMoveStep(workflowRunId);
            }
            await moveTicketStep(entry.ticketKey, target, transitionOwner);
            return { kind: "next", output: { status: "ok", target: targetName } };
          }

          default:
            // Exhaustiveness guard: every action block must be dispatched by
            // BLOCK_EXECUTORS or a case above. Reaching here means a
            // WorkflowBlockType was added without wiring an executor; fail the run
            // loudly instead of silently succeeding as a no-op.
            throw new Error(
              `workflow block type "${node.type}" has no executor registered`,
            );
        }
      };

      const hooks = {
        async onBlockStart(nodeId: string, attempt: number) {
          await enforceBudgetAtBoundary(true);
          activeBlockIds.add(nodeId);
          syncCurrentBlockId();
          state.attempt = attempt;
          blockStatuses[nodeId] = { status: "running", attempt };
          await writeBlockStatuses();
        },
        async onBlockFinish(nodeId: string, blockState: BlockRunState) {
          blockStatuses[nodeId] = blockRunStateSummary(blockState);
          await writeBlockStatuses();
          activeBlockIds.delete(nodeId);
          syncCurrentBlockId();
          await enforceBudgetAtBoundary(false);
        },
      };

      const runValues = {
        id: workflowRunId,
        branchName,
        defaultAgent: { provider: runDefaultKind, model: defaultModel },
        trigger: {
          id: entryTrigger.id,
          type: entryTrigger.type,
        },
      };
      const v2AgentArtifactKeys = buildV2AgentArtifactKeys(
        plan.definition.nodes,
      );
      const executeV2Block: V2BlockExecutor = async (
        node,
        steps,
        resolvedInputs,
        invocation,
      ) => {
        invocation.cancellation.throwIfCancelled();
        state.attempt = invocation.attempt;
        const harnessRuntime = ctx.harnessRuntimes[node.id];
        const invocationBudget = harnessRuntime
          ? await createHarnessInvocationBudget({
              workflowLimits: budgetLimits,
              runtime: harnessRuntime,
              phase: node.id,
              observeWorkflowBudget: observeBudgetAtBoundary,
              readClock: readRunBudgetClockStep,
              priceLookup,
            })
          : undefined;
        const bindingContext: V2BindingResolutionContext = {
          entryOutput: triggerOutput,
          runValues,
          getStepOutput: (nodeId) => steps[nodeId]?.output,
        };
        const configuration = resolveV2PromptDataConfiguration(
          node,
          bindingContext,
          { preserveAgentPromptSource: true },
        );
        const placeholderIssue = v2NonAgentPromptPlaceholderIssue(
          node.type,
          configuration,
        );
        if (placeholderIssue) {
          return executionError(placeholderIssue, {
            category: "binding",
            phase: node.type,
            message:
              "The block has an unresolved prompt placeholder. Update and redeploy the workflow.",
          });
        }
        const compileInvocationPrompt: NonNullable<
          BlockExecutionContext["compileEffectivePrompt"]
        > = async ({ blockPrompt, runtimeData, sandboxId }) => {
          const runtime = harnessRuntime;
          if (!runtime) {
            return {
              ok: false,
              result: executionError(
                "The pinned Harness Profile could not be resolved.",
                {
                  category: "schema",
                  phase: node.type,
                  message:
                    "The agent's Harness Profile is unavailable. Select a published profile version and deploy again.",
                },
              ),
            };
          }
          const profileSource = effectivePromptProfileSource(runtime);
          let repositorySources: Awaited<
            ReturnType<typeof loadInvocationRepositoryInstructionSources>
          > = [];
          if (
            runtime.manifest.context.includeRepositoryInstructions &&
            ctx.workspaceManifest
          ) {
            try {
              repositorySources =
                await loadInvocationRepositoryInstructionSources({
                  nodeType: node.type,
                  executionSandboxId: sandboxId,
                  sharedCodeSandboxId: ctx.sandboxId,
                  manifest: ctx.workspaceManifest,
                  enableRepoMemory: runSettings.ENABLE_REPO_MEMORY,
                });
            } catch (error) {
              if (isRunControlError(error)) throw error;
              return {
                ok: false,
                result: executionError(
                  `Repository instructions could not be loaded: ${errorMessage(error)}`,
                  {
                    category: "sandbox",
                    phase: node.type,
                    message:
                      "Repository instructions could not be loaded safely.",
                  },
                ),
              };
            }
          }
          // Every repository in the manifest, not only the write-scoped ones:
          // how to build and test a read-only dependency is worth knowing too.
          // Reads the database only, so planning_agent gets it without a
          // checkout. Gated here at the call site rather than inside the step:
          // a "use step" invocation writes a durable step record even when its
          // body returns immediately, and with the flag off the compiled prompt
          // must be identical to a build without the feature.
          let memorySources: Awaited<
            ReturnType<typeof loadRepoMemorySourcesStep>
          > = [];
          if (runSettings.ENABLE_REPO_MEMORY && ctx.workspaceManifest) {
            try {
              memorySources = await loadRepoMemorySourcesStep({
                repositories: ctx.workspaceManifest.repositories.map(
                  (repository) => ({
                    provider: repository.provider,
                    repoPath: repository.repoPath,
                  }),
                ),
              });
            } catch (error) {
              if (isRunControlError(error)) throw error;
              // Unlike repository instructions, unreadable memory must not fail
              // the invocation: it is an optimization the prompt is correct
              // without.
              memorySources = [];
            }
          }
          const compilation = await compileEffectivePrompt({
            nodeId: node.id,
            blockPrompt:
              blockPrompt.trim().length > 0
                ? blockPrompt
                : compatibilityPromptSourceForV2Node(node) ?? blockPrompt,
            runtimeData: runtime.manifest.context.includeWorkflowData
              ? runtimeData
              : "",
            slots: resolvedPrompts.slotsByNode[node.id] ?? [],
            slotBindings: node.configuration.promptSlotBindings,
            promptManifest:
              resolvedPrompts.manifestByNode[node.id] ?? [],
            profileSource,
            repositorySources,
            memorySources,
            bindingContext,
          });
          if (compilation.issues.length > 0) {
            return {
              ok: false,
              result: executionError(
                compilation.issues
                  .map((issue) => issue.message)
                  .join("; "),
                {
                  category: "binding",
                  phase: node.type,
                  message:
                    "The effective prompt is incomplete or has invalid values.",
                },
              ),
            };
          }
          return { ok: true, prompt: compilation.prompt };
        };
        if (node.type === "transform") {
          try {
            return {
              kind: "next",
              output: {
                status: "ok",
                output: await executeTransform(
                  configuration as unknown as TransformConfiguration,
                  bindingContext,
                  JSON_SCHEMA_SUPPORT,
                  transformRegexEvaluator,
                ),
              },
            };
          } catch (error) {
            return executionError(errorMessage(error), {
              category: "binding",
              phase: "transform",
            });
          }
        }
        if (node.type === "terminate") {
          const terminalStatus = configuration.terminalStatus;
          if (
            terminalStatus !== "waiting_for_human" &&
            terminalStatus !== "failed" &&
            terminalStatus !== "skipped" &&
            terminalStatus !== "done"
          ) {
            return executionError("Terminate has an invalid terminal status.", {
              category: "engine",
              phase: "terminate",
            });
          }
          const postComment =
            typeof configuration.postComment === "string"
              ? configuration.postComment
              : undefined;
          const result = v2TerminalBlockResult({
            terminalStatus,
            ...(postComment === undefined ? {} : { postComment }),
            ...(invocation.clarificationAnswer === undefined
              ? {}
              : { clarificationAnswer: invocation.clarificationAnswer }),
          });
          if (
            result.kind === "next" &&
            terminalStatus !== "waiting_for_human" &&
            postComment &&
            entry.ticketKey
          ) {
            await postTicketComment(
              ticket.identifier,
              postComment,
              transitionOwner,
            );
          }
          return result;
        }
        if (node.type === "open_pr") {
          const provenanceIssue =
            v2OpenPrRepositoriesProvenanceIssue({
              node,
              definition: plan.definition as WorkflowDefinitionV2,
              steps,
              resolvedInputs,
              publication: ctx.publication,
            });
          if (provenanceIssue) {
            return executionError(provenanceIssue, {
              category: "binding",
              phase: "open-pr",
            });
          }
        }
        const legacyNode = {
          id: node.id,
          type: node.type,
          ...(node.name ? { name: node.name } : {}),
          x: node.x,
          y: node.y,
          params: structuredClone(configuration) as unknown as Record<
            string,
            WorkflowParamValue
          >,
          inputs: {},
        } as unknown as WorkflowDefinitionNode;
        const result = await executeBlock(
          legacyNode,
          structuredClone(steps) as StepsRecord,
          structuredClone(resolvedInputs),
          {
            attempt: invocation.attempt,
            activationScopeId: invocation.activationScopeId,
            agentArtifactKey: v2AgentArtifactKeys.get(node.id)!,
            cancellation: invocation.cancellation,
            observations: invocation.observations,
            compileEffectivePrompt: compileInvocationPrompt,
            ...(invocationBudget
              ? {
                  observeBudget: invocationBudget.observeBudget,
                  recordBudgetUsage: invocationBudget.recordUsage,
                }
              : {}),
            ...(invocation.clarificationAnswer === undefined
              ? {}
              : { clarificationAnswer: invocation.clarificationAnswer }),
          },
        );
        if (invocationBudget) {
          const after = await invocationBudget.observeBudget(false);
          if (after.check.status !== "ok") {
            throw new RunBudgetError(after.check);
          }
        }
        invocation.cancellation.throwIfCancelled();
        return result;
      };

      // Awaited, not detached. These hooks write durable steps, so letting them
      // land whenever the event loop allows put them at a different position on
      // replay than in the original run, which is a replay divergence and takes
      // the whole run down (AIW-251). The hooks swallow their own write
      // failures, so awaiting them costs ordering only, never the run.
      const v2Hooks: V2SchedulerHooks = {
        async onTriggerActivated(event) {
          await v2RunObservation?.onTriggerActivated?.(event);
        },
        async onNodeStart(event) {
          await hooks.onBlockStart(event.nodeId, event.attempt);
          await v2RunObservation?.onNodeStart?.(event);
        },
        async onNodeWaiting(event) {
          await v2RunObservation?.onNodeWaiting?.(event);
        },
        async onNodeFinish(event) {
          await v2RunObservation?.onNodeFinish?.(event);
          await hooks.onBlockFinish(event.nodeId, event.state);
        },
        async onNodeSkipped(event) {
          await v2RunObservation?.onNodeSkipped?.(event);
          blockStatuses[event.nodeId] = {
            status: "ok",
            attempt: event.attempt,
          };
          await writeBlockStatuses();
        },
        async onExecutionError({ state: errorState, error, activationScopeId }) {
          if (error.diagnostic) {
            const observation =
              v2RunObservation?.observationHooksFor?.({
                nodeId: errorState.nodeId,
                attempt: errorState.attempt,
                activationScopeId,
              });
            const { stdoutTail, stderrTail } = error.diagnostic;
            void observation?.emit({
              kind: "metadata",
              value: {
                agentProtocol: safeReplayAgentProtocolMetadata(error.diagnostic),
              },
            });
            if (stdoutTail) {
              void observation?.emit({
                kind: "log",
                value: { stream: "stdout", tail: stdoutTail },
              });
            }
            if (stderrTail) {
              void observation?.emit({
                kind: "log",
                value: { stream: "stderr", tail: stderrTail },
              });
            }
          }
          await logWorkflowExecutionErrorStep(
            safeWorkflowExecutionLogEvent({
              diagnosticId: errorState.diagnosticId,
              nodeId: errorState.nodeId,
              attempt: errorState.attempt,
              category: errorState.category,
              ...(errorState.phase ? { phase: errorState.phase } : {}),
              // Without the detail here, a failure logs correlation metadata
              // only and the cause exists nowhere but the capped
              // customer-facing message.
              ...(error.detail ? { detail: error.detail } : {}),
              ...(errorState.message ? { message: errorState.message } : {}),
              ...(error.diagnostic
                ? { agentProtocol: error.diagnostic }
                : {}),
            }),
          );
        },
        observationHooksFor: (identity) =>
          v2RunObservation?.observationHooksFor?.(identity) ?? {
            emit() {},
          },
      };

      let walk: Awaited<ReturnType<typeof executeV2Graph>>;
      {
        const definition = plan.definition;
        let resume:
          | {
              checkpoint: V2SchedulerCheckpoint;
              clarificationAnswer: string;
            }
          | undefined;
        while (true) {
          const v2Walk = await executeV2Graph({
            runId: workflowRunId,
            definition,
            entryTriggerId: entryTrigger.id,
            triggerOutput,
            runValues,
            executeBlock: executeV2Block,
            hooks: v2Hooks,
            // The env value is an operational ceiling only, never a raise: see
            // V2_MAX_BLOCK_CONCURRENCY in infra/runtime-env.ts for what it is for and what
            // concurrent dispatch here depends on staying true.
            maxConcurrency: Math.min(
              runSettings.V2_MAX_BLOCK_CONCURRENCY ??
                V2_PRODUCTION_SCHEDULER_BOUNDS.maxConcurrency,
              V2_PRODUCTION_SCHEDULER_BOUNDS.maxConcurrency,
            ),
            maxTotalExecutions:
              V2_PRODUCTION_SCHEDULER_BOUNDS.maxTotalExecutions,
            shouldRethrowExecutionError: shouldRethrowAgentExecutionError,
            ...(resume ? { resume } : {}),
          });
          if (v2Walk.outcome !== "paused") {
            walk = v2Walk;
            break;
          }
          const clarification = v2Walk.clarification;
          if (!clarification) {
            throw new Error("v2 scheduler paused without clarification state");
          }
          const sourceSandboxId = ctx.sandboxId;
          const answer = await awaitClarification(
            clarification.questions,
            clarification.nodeId,
            clarification.suggestedAnswers,
            v2Walk.steps,
          );
          let checkpoint = v2Walk.state;
          if (
            sourceSandboxId &&
            ctx.sandboxId &&
            sourceSandboxId !== ctx.sandboxId
          ) {
            const { restoreCheckpointValueSandboxReferences } = await import(
              "./support/clarification-checkpoint.js"
            );
            checkpoint = restoreCheckpointValueSandboxReferences(
              checkpoint,
              sourceSandboxId,
              ctx.sandboxId,
            );
          }
          resume = { checkpoint, clarificationAnswer: answer };
        }
      }
      terminalExecutionError = walk.executionError ?? null;
      if (terminalExecutionError) {
        await failureExit(
          failureExitPhase(terminalExecutionError),
          formatExecutionErrorForUser(terminalExecutionError),
          terminalExecutionError.nodeId,
          // The walk's own steps, so the failure comment can read the
          // repository scripts output back out of them.
          walk.steps,
        );
      }
      // "completed" is the only genuine success: the walk ran out of work.
      // "ended" is a clean park, not a finish: send_plan_approval (the only
      // block that returns it) stopped the run while a human decides on the
      // plan, and nothing downstream of the gate ran. That is the same state a
      // clarification park records, so it records the same status and the
      // approval decision endpoints flip it off "awaiting" later. Calling it a
      // success here made a parked run read as shipped in every run listing.
      // No ticket move on either branch; the block owns that.
      // Constraint: never promote a clarification park to success here. The
      // terminate/clarification paths set runOutcome = "awaiting" and own it
      // (the answer endpoint flips it later), so a completed walk that left
      // "awaiting" set must keep it. The `as string` read is needed because TS
      // can't see the hook closures writing runOutcome and narrows it to its
      // "failed" initializer.
      if (
        !terminalExecutionError &&
        (walk.outcome === "completed" || walk.outcome === "ended") &&
        (runOutcome as string) !== "awaiting"
      ) {
        currentBlockId = null;
        runOutcome = walk.outcome === "ended" ? "awaiting" : "success";
      }
    } finally {
      // Capture the memory document before the sandbox that holds it is gone.
      // Failed and canceled runs learn things too, so this is not gated on the
      // outcome; nothing here may prevent the teardown below. Only the latest
      // workspace is captured: a prepare_workspace loop discards the memory of
      // its earlier iterations, which is the same thing that happens today.
      try {
        if (ctx.sandboxId && ctx.workspaceManifest) {
          await persistWorkspaceMemoryStep({
            sandboxId: ctx.sandboxId,
            subjectKey: ctx.entry.subjectKey,
            ticketKey: ctx.entry.ticketKey ?? null,
            taskId: ctx.ticket.identifier,
            workspaceManifest: ctx.workspaceManifest,
            runId: ctx.runId,
          });
        }
      } catch {
        // Best effort: the step already logs, teardown must still run.
      }
      // Tear down EVERY sandbox the run created, not just the latest
      // ctx.sandboxId: a prepare_workspace inside a loop provisions a fresh
      // sandbox each iteration, and all but the last would otherwise leak.
      await teardownSandboxes(ctx.sandboxIds);
      // Distill durable per-repository knowledge out of a run that actually
      // shipped. After the teardown so a slow provider call cannot keep paid
      // sandboxes alive, and gated on publication because an unpublished run
      // proves nothing about how to work in the repository. Everything is
      // swallowed: the run has already succeeded.
      try {
        const manifest = ctx.workspaceManifest;
        // Gated here at the call site rather than inside the step: a "use step"
        // invocation writes a durable step record even when its body returns
        // immediately, and the budget read below is itself a step.
        if (
          runSettings.ENABLE_REPO_MEMORY &&
          manifest &&
          runOutcome === "success" &&
          (ctx.publication?.status === "published" ||
            ctx.publication?.status === "finalized")
        ) {
          // Observed, never enforced: the run succeeded, so an exhausted budget
          // skips the distill instead of failing it.
          const budget = await ctx.observeBudget();
          if (budget.check.status === "ok") {
            const { provider, model } = repoMemoryDistillTarget(
              ctx.runDefaultKind,
              ctx.defaults,
            );
            const startedAt = Date.now();
            const distilled = await distillRepoMemoryStep({
              runId: ctx.runId,
              promoteOrgMemory: runSettings.ENABLE_ORG_MEMORY_PROMOTION,
              subjectKey: ctx.entry.subjectKey,
              taskId: ctx.ticket.identifier,
              repositories: manifest.repositories
                .filter(
                  (repo) => workspaceRepositoryAccess(manifest, repo) === "write",
                )
                .map((repo) => {
                  // Listed from the clone in prepare_workspace, before any agent
                  // block ran. The sandbox is already torn down above, and even
                  // if it were not, the workspace at this point is the branch
                  // this run pushed: the files it created exist there, so reading
                  // it would confirm exactly the entries the listing rejects.
                  const defaultBranchFiles =
                    ctx.defaultBranchFiles?.[`${repo.provider}:${repo.repoPath}`];
                  return Object.assign(
                    {
                      provider: repo.provider,
                      repoPath: repo.repoPath,
                    },
                    // Omitted rather than sent empty: absent means the capture
                    // had no trusted listing, which leaves the filter off.
                    defaultBranchFiles && defaultBranchFiles.length > 0
                      ? { defaultBranchFiles }
                      : {},
                  );
                }),
              changeSummary: ctx.changeSummary,
              model,
              ...(provider !== undefined ? { provider } : {}),
              // An ok budget only proves some duration is left, not 90s of it,
              // and this call delays the run's terminal telemetry until it
              // returns.
              timeoutMs: Math.max(
                1,
                Math.min(90_000, Math.floor(budget.remainingDurationMs)),
              ),
            });
            // Only a step that reached the provider costs anything. The step
            // says so directly rather than having the skip reasons enumerated
            // here, where every reason added later would silently drop the cost;
            // recording null for a call that never happened would mark the whole
            // run's cost unknown.
            const billable = distilled.providerCalled;
            if (billable) {
              const durationMs = Date.now() - startedAt;
              recordBlockPhaseUsage(
                ctx,
                "Repo memory distill",
                distilled.usage
                  ? {
                      cost_usd: null,
                      tokens: {
                        input: distilled.usage.inputTokens,
                        cached_input: distilled.usage.cachedTokens,
                        output: distilled.usage.outputTokens,
                      },
                      duration_ms: durationMs,
                      duration_api_ms: durationMs,
                      num_turns: 1,
                    }
                  : null,
                provider,
                model,
                // Pin the attempt so the label never inherits the last block's
                // retry count and reads "Repo memory distill #3".
                { attempt: 1 },
              );
            }
          }
        }
      } catch {
        // Best effort: the step already logs, and memory must never turn a
        // successful run into a failed one.
      }
    }
  } catch (caught) {
    reconcileMissingPhaseUsages();
    let err = await reconcileRunBudgetErrorAtBoundary(caught, observeBudgetAtBoundary);
    terminalBudgetFailure = runBudgetFailureFromError(err);
    const controlError = isRunControlError(err);
    if (!controlError) {
      const nodeId = currentBlockId ?? "engine";
      const attempt = blockStatuses[nodeId]?.attempt ?? 1;
      const blockError = unhandledAgentExecutionError(err, currentBlockId);
      const diagnostic = createWorkflowExecutionErrorState(
        workflowRunId,
        nodeId,
        attempt,
        blockError,
      );
      terminalExecutionError ??= diagnostic;
      console.error(
        `[${diagnostic.diagnosticId}] unhandled workflow execution error`,
      );
      err = new WorkflowExecutionError(terminalExecutionError);
    }
    const { handleUnhandledWorkflowError } = await import("./runtime/workflow-failure-exit.js");
    await handleUnhandledWorkflowError(err, {
      recordBlockFailure: async (error) => {
        if (!currentBlockId) return;
        blockStatuses[currentBlockId] = {
          status: "fail",
          error: terminalExecutionError?.message ?? truncateError(errorMessage(error)),
          ...(terminalExecutionError
            ? { diagnosticId: terminalExecutionError.diagnosticId }
            : {}),
        };
        await writeBlockStatuses();
      },
      applyDefaultFailure: async (error) => {
        console.error(
          `[${terminalExecutionError?.diagnosticId ?? "workflow-failed"}] Workflow failed for ${ticket.identifier}`,
        );
        if (!entry.ticketKey) return;

        // Persist "failed" before this backlog move fires the self-triggered
        // "ticket left the AI column" webhook (same race as failureExit).
        await markRunFailedOnSelfMoveStep(workflowRunId);
        let moved = false;
        try {
          await moveTicketStep(
            ticketId,
            backlogMoveTarget(),
            transitionOwner,
          );
          moved = true;
        } catch (moveError) {
          if (isRunControlError(moveError)) throw moveError;
        }

        try {
          await notifyTicket(ticket.identifier, {
            kind: "failed",
            reason: errorMessage(error),
            usageReport: usageReportOrUndefined(),
          }, transitionOwner);
        } catch (notifyError) {
          if (isRunControlError(notifyError)) throw notifyError;
        }

        if (!moved) {
          await markTicketFailed(
            ticket.identifier,
            workflowRunId,
            `Failed to move ticket to backlog: ${errorMessage(error)}`,
            transitionOwner,
          ).catch(() => {});
        }
      },
    });
    if (controlError) throw err;
  } finally {
    if (
      entry.kind === "pr_trigger" &&
      (runOutcome as string) !== "awaiting"
    ) {
      const successfulWithPendingCheck = runOutcome === "success";
      const details = successfulWithPendingCheck
        ? "Workflow finished without completing a pending PR check."
        : terminalExecutionError
          ? formatExecutionErrorForUser(terminalExecutionError)
          : "Workflow failed before the PR check was completed.";
      const cleanup = await closeTerminalPrChecksStep({
        runId: workflowRunId,
        intent: pendingPrCheckIntent({
          category: terminalExecutionError?.category,
          budgetMetric: terminalBudgetFailure?.metric,
        }),
        details,
      }).catch(() => ({ closed: 0, pending: 1 }));
      if (
        successfulWithPendingCheck &&
        (cleanup.closed > 0 || cleanup.pending > 0)
      ) {
        runOutcome = "failed";
        const error = executionError(details, {
          category: "engine",
          phase: "pr-check-cleanup",
        }).error;
        terminalExecutionError = createWorkflowExecutionErrorState(
          workflowRunId,
          "pr-check-cleanup",
          1,
          error,
        );
      }
    }
    await v2RunObservation?.finalize("workflow_finished");
    // A launched phase with no parsed usage (timed out / errored before
    // collect) records as unknown, so computeUsageTotals reports
    // costKnown=false instead of a misleading costUsd=0 / costKnown=true.
    reconcileMissingPhaseUsages();
    // Durable cost/usage telemetry, recorded on every exit path (success,
    // clarification, or failure). Its idempotent upsert retries as a durable
    // step and each failed attempt is logged inside that step; an exhausted
    // retry budget is logged once more and then swallowed here so telemetry
    // cannot replace the run's decided outcome.
    await persistRunTelemetryBestEffort(
      {
        runId: workflowRunId,
        subjectKey: entry.subjectKey,
        status: runOutcome,
        ticketKey: entry.ticketKey ?? null,
        ticketTitle: ticket.title,
        ticketUrl: entry.ticketKey
          ? `${env.JIRA_BASE_URL.replace(/\/+$/, "")}/browse/${ticket.identifier}`
          : entry.kind === "pr_trigger"
            ? entry.pr.prUrl
            : null,
        model: activeModel ?? null,
        totals: computeUsageTotals(
          runPhaseUsages,
          runPhaseProviders,
          priceLookup,
          activeModel,
          runPhaseModels,
        ),
        budgetFailure: terminalBudgetFailure,
        pr: prForTelemetry,
        prs: prsForTelemetry,
        executionError: terminalExecutionError
          ? {
              message: formatExecutionErrorForUser(terminalExecutionError),
              code: terminalExecutionError.diagnosticId,
            }
          : null,
        harnessManifests,
      },
    );
  }
  return terminalExecutionError
    ? { kind: "execution_error", error: terminalExecutionError }
    : runOutcome;
}
