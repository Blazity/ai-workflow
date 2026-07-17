import { getWorkflowMetadata } from "workflow";
import { branchForTicket } from "../lib/branch-prefix.js";
import { ticketRunUrl, ticketPageUrl, hasDashboardLinkComment } from "../lib/dashboard-links.js";
import { computeUsageTotals, type UsageTotals } from "../sandbox/usage.js";
import type {
  AgentOutput, PhaseUsage, PhaseKind, PhaseArtifactPaths, ResearchResult, ReviewOutput,
} from "../sandbox/agents/types.js";
import type { AgentKind } from "../sandbox/agents/index.js";
import type {
  IssueTrackerMoveTarget,
  TicketAttachment,
} from "../adapters/issue-tracker/types.js";
import type { TicketEvent } from "../adapters/messaging/types.js";
import type { DownloadedAttachment } from "../sandbox/attachments.js";
import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";
import { buildRuntimeGraph, executeGraph } from "../workflow-definition/interpreter.js";
import type {
  BlockExecutionResult,
  BlockExecutor,
  ExecuteGraphHooks,
} from "../workflow-definition/interpreter.js";
import { resolveBlockAgent, resolveRunDefaultKind } from "../workflow-definition/resolve-agent.js";
import { resolveTicketMoveTarget } from "./ticket-move-target.js";
import type { AgentWorkflowInput } from "./agent-input.js";
import type { BlockExecuteFn, EngineCtx } from "./blocks/types.js";
import {
  ensureWorkspace,
  execute as executePrepareWorkspace,
} from "./blocks/prepare-workspace.js";
import { ensureAgentSandbox } from "./blocks/agent-sandbox.js";
import { execute as executeFinalizeWorkspace } from "./blocks/finalize-workspace.js";
import { execute as executeFixAgent } from "./blocks/fix-agent.js";
import { execute as executeGenericAgent } from "./blocks/generic-agent.js";
import {
  execute as executeCallLlm,
  resolveCallLlmTarget,
} from "./blocks/call-llm.js";
import { pollPhaseUntilDone } from "./blocks/poll-phase.js";
import {
  RunBudgetError,
  addActiveElapsed,
  createRunBudgetState,
  durationBudgetFailure,
  isDurationAbortError,
  missingRequiredPriceFailure,
  observeRunBudget,
  recordBudgetUsage,
  type RunBudgetLimits,
  type RunBudgetFailure,
  type RunBudgetObservation,
  type RunBudgetState,
} from "./run-budget.js";
import { execute as executeFetchPrContext } from "./blocks/fetch-pr-context.js";
import { execute as executeRunChecks } from "./blocks/run-checks.js";
import { execute as executePostTicketComment } from "./blocks/post-ticket-comment.js";
import { execute as executePostPrComment } from "./blocks/post-pr-comment.js";
import { execute as executeHumanQuestion } from "./blocks/human-question.js";
import { execute as executeArthurInjectionCheck } from "./blocks/arthur-injection-check.js";
import { execute as executeSendPlanApproval } from "./blocks/send-plan-approval.js";
import { BLOCK_TYPE_SPECS, isTriggerBlockType } from "@shared/contracts";
import type {
  BlockOutput,
  BlockRunState,
  WorkflowBlockType,
  WorkflowDefinitionNode,
} from "@shared/contracts";

const BLOCK_EXECUTORS: Partial<Record<WorkflowBlockType, BlockExecuteFn>> = {
  prepare_workspace: executePrepareWorkspace,
  finalize_workspace: executeFinalizeWorkspace,
  fix_agent: executeFixAgent,
  generic_agent: executeGenericAgent,
  call_llm: executeCallLlm,
  fetch_pr_context: executeFetchPrContext,
  run_checks: executeRunChecks,
  post_ticket_comment: executePostTicketComment,
  post_pr_comment: executePostPrComment,
  human_question: executeHumanQuestion,
  arthur_injection_check: executeArthurInjectionCheck,
  send_plan_approval: executeSendPlanApproval,
};

// Action blocks executed by the inline switch inside executeBlock (they need
// run-scoped closure state, so they can't live in the registry above). Kept in
// sync with the switch cases; blockTypesMissingExecutor() (asserted in tests)
// turns any drift into a loud failure instead of a silent no-op.
const INLINE_EXECUTED_BLOCK_TYPES: readonly WorkflowBlockType[] = [
  "planning_agent",
  "implementation_agent",
  "review_agent",
  "run_pre_pr_checks",
  "open_pr",
  "send_slack_message",
  "update_ticket_status",
];

/** Action block types with no executor wired in either BLOCK_EXECUTORS or the
 *  inline switch. Empty in a correct build: a non-empty result means a
 *  WorkflowBlockType was added to the contract without an executor. executeBlock
 *  fails such a run loudly at runtime; this makes the same gap catchable in a test. */
export function blockTypesMissingExecutor(): WorkflowBlockType[] {
  return (Object.keys(BLOCK_TYPE_SPECS) as WorkflowBlockType[]).filter(
    (type) =>
      BLOCK_TYPE_SPECS[type].category === "action" &&
      BLOCK_EXECUTORS[type] === undefined &&
      !INLINE_EXECUTED_BLOCK_TYPES.includes(type),
  );
}

export function modelsRequiringPriceLookup(
  nodes: WorkflowDefinitionNode[],
  runDefaultKind: AgentKind,
  defaults: { claude: string; codex: string },
): Set<string> {
  const models = new Set<string>();
  for (const node of nodes) {
    if (
      node.type === "planning_agent" ||
      node.type === "implementation_agent" ||
      node.type === "review_agent" ||
      node.type === "fix_agent" ||
      node.type === "generic_agent"
    ) {
      const resolved = resolveBlockAgent(node.params, runDefaultKind, defaults);
      if (resolved.kind === "codex") models.add(resolved.model);
    } else if (node.type === "call_llm") {
      models.add(resolveCallLlmTarget(node.params, runDefaultKind, defaults).model);
    }
  }
  if (runDefaultKind === "codex") models.add(defaults.codex);
  return models;
}

export function recordPrePrFixCycleUsages(
  ctx: Pick<EngineCtx, "markLaunched" | "recordUsage">,
  usages: ReadonlyArray<PhaseUsage | null>,
  model: string,
  budgetFailure: RunBudgetFailure | null = null,
): void {
  usages.forEach((usage, index) => {
    const label = `Pre-PR Fix ${index + 1}`;
    ctx.markLaunched(label);
    ctx.recordUsage(label, usage, model);
  });
  if (budgetFailure) throw new RunBudgetError(budgetFailure);
}

export function resolveSlackMessageInput(
  params: Record<string, unknown>,
  resolvedInputs: Record<string, unknown>,
): string {
  return typeof resolvedInputs.message === "string"
    ? resolvedInputs.message.trim()
    : typeof params.message === "string"
      ? params.message.trim()
      : "";
}

export function resolveTicketStatusInput(
  params: Record<string, unknown>,
  resolvedInputs: Record<string, unknown>,
): "ai_review" | "backlog" {
  return resolveTicketMoveTarget(
    typeof resolvedInputs.target === "string" ? resolvedInputs.target : params.target,
  );
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

export async function ensurePlanningAgentSandboxForBlock(
  ctx: EngineCtx,
  kind: AgentKind,
  model: string,
): Promise<
  | { kind: "ready"; sandboxId: string }
  | Extract<BlockExecutionResult, { kind: "failed" }>
> {
  try {
    return { kind: "ready", sandboxId: await ensureAgentSandbox(ctx, kind, model) };
  } catch (error) {
    return {
      kind: "failed",
      output: { status: "failed" },
      reason: error instanceof Error ? error.message : String(error),
      phase: "research",
    };
  }
}

/** Entry kinds that own the ticket's main work thread and may run the re-pickup
 *  clarification housekeeping (label strip, pending supersede, awaiting flip). A
 *  pr_trigger / plan_approved run is a PR/plan follow-up that does not own the
 *  ticket's clarification state, so it must be excluded: superseding a live
 *  pending question or flipping the parked asking run to success would silently
 *  strand the human's question with nothing left to re-pick the ticket up. */
export function entryOwnsClarificationThread(kind: AgentWorkflowInput["kind"]): boolean {
  return kind === "ticket" || kind === "clarification_answered";
}

function triggerTypeFor(entry: AgentWorkflowInput): WorkflowBlockType {
  if (entry.kind === "pr_trigger") return entry.triggerType;
  if (entry.kind === "plan_approved") return "trigger_plan_approved";
  return "trigger_ticket_ai";
}

function triggerOutputFor(entry: AgentWorkflowInput): BlockOutput {
  if (entry.kind === "pr_trigger") {
    const { pr } = entry;
    const output: BlockOutput = {
      status: "fired",
      ticketKey: entry.ticketKey,
      provider: pr.provider,
      repoPath: pr.repoPath,
      prNumber: pr.prNumber,
      prUrl: pr.prUrl,
      headRef: pr.headRef,
      headSha: pr.headSha,
      baseRef: pr.baseRef,
      title: pr.title,
      author: pr.author,
      isDraft: pr.isDraft,
    };
    if (pr.failedChecks) {
      output.failedChecks = pr.failedChecks.map((check) => ({
        name: check.name,
        conclusion: check.conclusion,
        ...(check.detailsUrl !== undefined ? { detailsUrl: check.detailsUrl } : {}),
      }));
    }
    if (pr.review) {
      output.review = {
        state: pr.review.state,
        author: pr.review.author,
        body: pr.review.body,
      };
    }
    return output;
  }
  if (entry.kind === "plan_approved") {
    return {
      status: "fired",
      ticketKey: entry.ticketKey,
      approvedPlan: entry.approvedPlan.markdown,
      approver: entry.approval.approver,
      approvedAt: entry.approval.approvedAt,
    };
  }
  return { status: "fired", ticketKey: entry.ticketKey };
}

// --- Step Functions ---

async function fetchAndValidateTicket(
  ticketId: string,
  columnAi: string,
  skipColumnCheck: boolean,
) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { issueTracker } = createStepAdapters();
  const ticket = await issueTracker.fetchTicket(ticketId);
  if (!skipColumnCheck && ticket.trackerStatus.toLowerCase() !== columnAi.toLowerCase()) {
    return null;
  }
  return ticket;
}

async function fetchAttachments(
  ticketIdentifier: string,
  attachments: TicketAttachment[],
) {
  "use step";
  const { logger } = await import("../lib/logger.js");
  const log = logger.child({ ticket_identifier: ticketIdentifier, step: "fetchAttachments" });
  log.info({ count: attachments.length }, "fetchAttachments: start");

  if (attachments.length === 0) {
    log.info({}, "fetchAttachments: no attachments");
    return [];
  }

  const { env } = await import("../../env.js");
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { fetchAttachmentsWithRetry } = await import("../sandbox/attachments.js");
  const { issueTracker } = createStepAdapters();

  // downloadAttachment is optional on IssueTrackerAdapter — not all trackers
  // support it. If absent, skip attachments cleanly.
  if (typeof issueTracker.downloadAttachment !== "function") {
    log.warn(
      { tracker: issueTracker.constructor.name },
      "issue tracker does not support attachment downloads; skipping",
    );
    return [];
  }

  const downloader = issueTracker as {
    downloadAttachment: (url: string, opts?: { timeoutMs?: number }) => Promise<Buffer>;
  };

  const result = await fetchAttachmentsWithRetry(
    downloader,
    attachments,
    {
      maxFileSizeBytes: env.ATTACHMENT_MAX_FILE_SIZE_MB * 1024 * 1024,
      maxTotalSizeBytes: env.ATTACHMENT_MAX_TOTAL_SIZE_MB * 1024 * 1024,
      maxCount: env.ATTACHMENT_MAX_COUNT,
      downloadTimeoutMs: env.ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
    },
    log,
  );
  log.info(
    {
      succeeded: result.filter((a) => !a.failed).length,
      failed: result.filter((a) => a.failed).length,
    },
    "fetchAttachments: done",
  );
  return result;
}
fetchAttachments.maxRetries = 0;

async function writeAttachments(
  sandboxId: string,
  attachments: DownloadedAttachment[],
): Promise<void> {
  "use step";
  const { logger } = await import("../lib/logger.js");
  const log = logger.child({ sandboxId, step: "writeAttachments" });

  const toWrite = attachments.filter((a) => a.content && !a.failed);
  log.info(
    { count: toWrite.length, totalReceived: attachments.length },
    "writeAttachments: start",
  );
  if (toWrite.length === 0) {
    log.info({}, "writeAttachments: nothing to write");
    return;
  }

  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../sandbox/credentials.js");

  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

  // Ensure target directory exists — writeFiles does not guarantee mkdir -p semantics.
  await sandbox.runCommand("mkdir", ["-p", "/tmp/attachments"]);

  await sandbox.writeFiles(
    toWrite.map((a) => ({
      path: `/tmp/attachments/${a.filename}`,
      content: Buffer.isBuffer(a.content)
        ? (a.content as Buffer)
        : Buffer.from(a.content as unknown as Uint8Array),
    })),
  );
  log.info({ count: toWrite.length }, "writeAttachments: done");
}
writeAttachments.maxRetries = 0;

async function writeAndStartPhase(
  sandboxId: string,
  inputFilePath: string,
  inputContent: string,
  scriptPath: string,
  scriptContent: string,
): Promise<string> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../sandbox/credentials.js");

  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

  await sandbox.writeFiles([
    { path: inputFilePath, content: Buffer.from(inputContent) },
    { path: scriptPath, content: Buffer.from(scriptContent) },
  ]);
  await sandbox.runCommand("chmod", ["+x", scriptPath]);

  const command = await sandbox.runCommand({
    cmd: "bash",
    args: [scriptPath],
    cwd: "/vercel/sandbox",
    detached: true,
  });
  return command.cmdId;
}
writeAndStartPhase.maxRetries = 0;

async function fetchModelPriceStep(model: string): Promise<{ input: number; cached_input: number; output: number } | null> {
  "use step";
  const { fetchModelPrice } = await import("../sandbox/agents/pricing.js");
  try {
    return await fetchModelPrice(model);
  } catch (err) {
    const { logger } = await import("../lib/logger.js");
    logger.warn({ err: (err as Error).message, model }, "pricing_fetch_failed");
    return null;
  }
}
fetchModelPriceStep.maxRetries = 0;

async function readRunBudgetClockStep(): Promise<number> {
  "use step";
  return Date.now();
}
readRunBudgetClockStep.maxRetries = 0;

async function setCommitGuardStep(sandboxId: string, agentKind: AgentKind, enabled: boolean): Promise<void> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../sandbox/credentials.js");
  const { createAgentAdapter } = await import("../sandbox/agents/index.js");

  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const agent = createAgentAdapter(agentKind);
  await agent.setCommitGuard(sandbox, enabled);
}

// Step wrappers around the AgentAdapter class methods. The adapter classes
// transitively reach the pino logger (via installArthurTracer); the workflow
// bundler can't tolerate that, so all adapter method calls happen inside
// step bundles rather than the workflow body.
async function planPhaseStep(
  agentKind: AgentKind,
  phase: PhaseKind,
  model: string,
  jsonSchema?: string,
): Promise<{ paths: PhaseArtifactPaths; script: string }> {
  "use step";
  const { createAgentAdapter } = await import("../sandbox/agents/index.js");
  const a = createAgentAdapter(agentKind);
  const paths = a.artifactPaths(phase);
  const script = a.buildPhaseScript({ phase, model, paths, jsonSchema });
  return { paths, script };
}

async function parseResearchStep(
  agentKind: AgentKind,
  raw: string,
  structured: string | null,
): Promise<{ research: ResearchResult; usage: PhaseUsage | null }> {
  "use step";
  const { createAgentAdapter } = await import("../sandbox/agents/index.js");
  const a = createAgentAdapter(agentKind);
  return { research: a.parseResearchStatus(raw, structured), usage: a.extractUsage(raw, structured) };
}

async function parseAgentOutputStep(
  agentKind: AgentKind,
  raw: string,
  structured: string | null,
): Promise<{ output: AgentOutput; usage: PhaseUsage | null }> {
  "use step";
  const { createAgentAdapter } = await import("../sandbox/agents/index.js");
  const a = createAgentAdapter(agentKind);
  return { output: a.parseAgentOutput(raw, structured), usage: a.extractUsage(raw, structured) };
}

async function parseReviewStep(
  agentKind: AgentKind,
  raw: string,
  structured: string | null,
): Promise<{ output: ReviewOutput; usage: PhaseUsage | null }> {
  "use step";
  const { createAgentAdapter } = await import("../sandbox/agents/index.js");
  const a = createAgentAdapter(agentKind);
  return { output: a.parseReviewOutput(raw, structured), usage: a.extractUsage(raw, structured) };
}

async function postPrLinksComment(
  ticketId: string,
  prs: Array<{ provider: SelectedRepository["provider"]; repoPath: string; url: string; id: number }>,
  heading = "Pull requests ready for review:",
): Promise<void> {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { issueTracker } = createStepAdapters();
  const lines = prs.map((pr) => `- ${pr.provider}:${pr.repoPath}: #${pr.id} ${pr.url}`);
  try {
    await issueTracker.postComment(ticketId, `${heading}\n${lines.join("\n")}`);
  } catch (err) {
    const { logger } = await import("../lib/logger.js");
    logger.warn(
      { ticketId, prs, err: errorMessage(err) },
      "pr_links_comment_failed",
    );
  }
}
postPrLinksComment.maxRetries = 0;

async function moveTicket(ticketId: string, target: IssueTrackerMoveTarget) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { issueTracker } = createStepAdapters();
  await issueTracker.moveTicket(ticketId, target);
}

async function postTicketComment(ticketId: string, comment: string): Promise<void> {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { issueTracker } = createStepAdapters();
  await issueTracker.postComment(ticketId, comment);
}

async function notifyTicket(ticketKey: string, event: TicketEvent) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { messaging } = createStepAdapters();
  await messaging.notifyForTicket(ticketKey, event);
}

async function logPhaseFailure(
  ticketKey: string,
  phase: string,
  reason: string,
): Promise<void> {
  "use step";
  const { logger } = await import("../lib/logger.js");
  logger.warn(
    { ticketKey, phase, reason: reason.slice(0, 1_000) },
    "agent_phase_failed",
  );
}
logPhaseFailure.maxRetries = 0;

async function createClarificationRequestStep(input: {
  ticketKey: string;
  runId: string;
  blockId: string | null;
  definitionId: number | null;
  definitionVersion: number | null;
  questions: string[];
  suggestedAnswers: string[] | null;
}): Promise<string> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { createClarificationRequest } = await import("../clarifications/store.js");
  const row = await createClarificationRequest(getDb(), input);
  return row.id;
}
// maxRetries = 0 (mirrors createApprovalRequestStep): the questions are filed
// durably before any ticket movement, so a thrown insert must fail the run
// visibly rather than retry into an inconsistent state.
createClarificationRequestStep.maxRetries = 0;

async function parkForClarificationStep(
  ticketId: string,
  backlogTarget: IssueTrackerMoveTarget,
  clarificationRequestId: string,
): Promise<boolean> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { getClarification } = await import("../clarifications/store.js");
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { NEEDS_CLARIFICATION_LABEL } = await import("../lib/labels.js");
  // The pending row is answerable the moment it exists, so a user can answer
  // (claiming the ticket into the AI column and starting the resume run) before
  // this park runs. Re-read the row first: if it is no longer pending the answer
  // already owns the ticket, so skip the label add and backlog move that would
  // otherwise yank the ticket back and get the resume run cancelled. Return
  // false so the caller sends no notify and records the run as done, not
  // awaiting.
  const row = await getClarification(getDb(), clarificationRequestId);
  if (!row || row.status !== "pending") {
    return false;
  }
  const { issueTracker } = createStepAdapters();
  // No Jira comment: the questions live durably in the clarification store and
  // the overview reads awaiting state from the DB. The label is ticket-status
  // truth only now (it no longer drives any Jira scan). Best-effort, so a label
  // failure never blocks the park.
  if (typeof issueTracker.updateLabels === "function") {
    try {
      await issueTracker.updateLabels(ticketId, {
        add: [NEEDS_CLARIFICATION_LABEL],
      });
    } catch (err) {
      const { logger } = await import("../lib/logger.js");
      logger.warn(
        { ticketId, err: errorMessage(err) },
        "clarification_label_add_failed",
      );
    }
  }
  await issueTracker.moveTicket(ticketId, backlogTarget);
  return true;
}

async function reconcileClarificationsOnPickup(
  ticketKey: string,
  currentRunId: string,
  answeredClarificationId: string | null,
): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { NEEDS_CLARIFICATION_LABEL } = await import("../lib/labels.js");
  const { recordDispatchedRun, supersedePendingForTicket } = await import("../clarifications/store.js");
  const { resolveAwaitingRunsForTicket } = await import("../lib/telemetry/run-telemetry.js");
  const { issueTracker } = createStepAdapters();
  // Re-pickup housekeeping, all idempotent so default step retries are safe:
  //  - drop the awaiting-input label (best-effort; a label error must not fail
  //    the fresh run),
  //  - self-heal a lost endpoint setDispatchedRunId (clarification_answered
  //    resumes only): record this run id on the answered clarification so the
  //    row never stays permanently retryable. Guarded so it never overwrites the
  //    endpoint's own write.
  //  - supersede any still-pending clarification (a no-op for a
  //    clarification_answered entry whose row was already answered),
  //  - flip parked predecessor runs off "awaiting" so they don't linger.
  if (typeof issueTracker.updateLabels === "function") {
    try {
      await issueTracker.updateLabels(ticketKey, {
        remove: [NEEDS_CLARIFICATION_LABEL],
      });
    } catch (err) {
      const { logger } = await import("../lib/logger.js");
      logger.warn(
        { ticketKey, err: errorMessage(err) },
        "clarification_label_remove_failed",
      );
    }
  }
  const db = getDb();
  if (answeredClarificationId) {
    await recordDispatchedRun(db, answeredClarificationId, currentRunId);
  }
  await supersedePendingForTicket(db, ticketKey);
  await resolveAwaitingRunsForTicket(db, ticketKey, currentRunId);
}

async function postPickupCommentStep(ticketKey: string): Promise<void> {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { env } = await import("../../env.js");
  const { issueTracker } = createStepAdapters();
  // No run param: the ticket view auto-selects the newest run. The link doubles
  // as the idempotency marker (hasDashboardLinkComment), so this must post at
  // most once per ticket. Best-effort: a post failure must not fail the run.
  const url = ticketPageUrl(env.DASHBOARD_ORIGIN, ticketKey);
  try {
    await issueTracker.postComment(
      ticketKey,
      `AI workflow picked this ticket up. Follow progress and answer questions in the dashboard: ${url}`,
    );
  } catch (err) {
    const { logger } = await import("../lib/logger.js");
    logger.warn(
      { ticketKey, err: errorMessage(err) },
      "pickup_comment_failed",
    );
  }
}
postPickupCommentStep.maxRetries = 0;

async function loadClarificationHistoryStep(
  ticketKey: string,
): Promise<Array<{ questions: string[]; answer: string; answeredBy?: string; answeredAt?: string }>> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { listAnsweredForTicket } = await import("../clarifications/store.js");
  const rows = await listAnsweredForTicket(getDb(), ticketKey);
  return rows
    .filter((r) => r.answer !== null)
    .map((r) => ({
      questions: r.questions,
      answer: r.answer as string,
      ...(r.answeredByLabel ? { answeredBy: r.answeredByLabel } : {}),
      ...(r.answeredAt ? { answeredAt: r.answeredAt.toISOString() } : {}),
    }));
}

async function logClarificationHistoryFailure(ticketKey: string, reason: string): Promise<void> {
  "use step";
  const { logger } = await import("../lib/logger.js");
  logger.warn(
    { ticketKey, reason: reason.slice(0, 1_000) },
    "clarification_history_load_failed",
  );
}
logClarificationHistoryFailure.maxRetries = 0;

async function unregisterRun(ticketIdentifier: string) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { runRegistry } = createStepAdapters();
  await runRegistry.unregister(ticketIdentifier);
}

async function unregisterRunIfCurrent(ticketIdentifier: string, runId: string) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { runRegistry } = createStepAdapters();
  await runRegistry.unregisterIfRunId(ticketIdentifier, runId);
}

async function resolveAgentKindOverride(labels: readonly string[]): Promise<AgentKind | null> {
  "use step";
  const { parseAgentKindOverride } = await import("../sandbox/agents/index.js");
  return parseAgentKindOverride(labels);
}

async function runPrePrChecksStep(
  sandboxId: string,
  agentKind: AgentKind,
  model: string,
  maxFixCycles?: number,
  timeoutMs?: number,
  budget?: {
    state: RunBudgetState;
    limits: RunBudgetLimits;
    price: { input: number; cached_input: number; output: number } | null;
  },
): Promise<{
  passed: boolean;
  fixCycles: number;
  fixCycleUsages: Array<PhaseUsage | null>;
  budgetFailure: RunBudgetFailure | null;
  summary: string;
}> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { getCurrentPrePrCheckConfig } = await import("../pre-pr-checks/store.js");
  const { emptyPrePrCheckConfig } = await import("../pre-pr-checks/config.js");
  const { runPrePrChecksWithFixes } = await import("../pre-pr-checks/runner.js");
  const { logger } = await import("../lib/logger.js");
  const current = await getCurrentPrePrCheckConfig(getDb());
  logger.info(
    { version: current?.version ?? null },
    "pre_pr_checks_config_version",
  );
  return runPrePrChecksWithFixes(
    sandboxId,
    current?.config ?? emptyPrePrCheckConfig,
    agentKind,
    model,
    maxFixCycles,
    timeoutMs,
    budget,
  );
}
runPrePrChecksStep.maxRetries = 0;

async function markTicketFailed(ticketIdentifier: string, error: string) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { runRegistry } = createStepAdapters();
  const runId = await runRegistry.getRunId(ticketIdentifier) ?? "unknown";
  await runRegistry.markFailed(ticketIdentifier, {
    runId,
    error,
    failedAt: new Date().toISOString(),
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncateError(text: string): string {
  return text.length > 500 ? text.slice(0, 500) : text;
}

const FAILURE_PHASES = new Set(["research", "impl", "review", "pre-pr-checks", "push"]);

type NotifyPhase = "research" | "impl" | "review" | "pre-pr-checks" | "push";

function phaseKey(base: string, attempt: number): string {
  return attempt <= 1 ? base : `${base} #${attempt}`;
}

/**
 * Persist the run's cost/usage (+ agent PR + ticket) to the durable telemetry
 * table. Called from the workflow's outer finally so cost is recorded on every
 * exit — success, clarification, or failure. maxRetries = 0 and the caller
 * swallows errors: telemetry must never retry or fail the run.
 */
async function recordRunTelemetryStep(payload: {
  runId: string;
  status: "success" | "failed" | "awaiting";
  ticketKey: string;
  ticketTitle: string;
  ticketUrl: string;
  model: string | null;
  totals: UsageTotals;
  budgetFailure: RunBudgetFailure | null;
  pr: { url: string; number: number } | null;
  awaitingClarificationId?: string | null;
}) {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { recordRunUsage } = await import("../lib/telemetry/run-telemetry.js");
  const { getWorld } = await import("workflow/runtime");
  const collectRunDetailMod = await import(
    "../lib/overview/collect-run-detail.js"
  );
  const steps = await collectRunDetailMod.captureRunStepsBestEffort(
    getWorld() as unknown as import("../lib/overview/collect-run-detail.js").RunDetailSource,
    payload.runId,
  );
  const { totals } = payload;
  // Deterministically close the answer-before-finally window: a run parking on a
  // clarification records "awaiting", but if the answer already landed (row no
  // longer pending) that would be a phantom the cron freeze preserves forever.
  // Re-check the row on the awaiting path only and record "success" instead.
  let status = payload.status;
  if (status === "awaiting" && payload.awaitingClarificationId) {
    const { getClarification } = await import("../clarifications/store.js");
    const row = await getClarification(getDb(), payload.awaitingClarificationId);
    if (row && row.status !== "pending") {
      status = "success";
    }
  }
  await recordRunUsage(getDb(), {
    runId: payload.runId,
    // This is the agent workflow — its canonical identity (mirrors
    // WORKFLOW_MAP.agentWorkflow in lib/overview/collect-runs.ts). Recorded here
    // so the run is attributed even when no cron snapshot ever observes it.
    workflowId: "wf_agent",
    workflowName: "Agent",
    status,
    ticketKey: payload.ticketKey,
    ticketTitle: payload.ticketTitle,
    ticketUrl: payload.ticketUrl,
    model: payload.model,
    costUsd: totals.costUsd,
    costKnown: totals.costKnown,
    tokensInput: totals.tokensInput,
    tokensCached: totals.tokensCached,
    tokensOutput: totals.tokensOutput,
    phases: totals.phases,
    steps,
    budgetFailure: payload.budgetFailure,
    prUrl: payload.pr?.url ?? null,
    prNumber: payload.pr?.number ?? null,
  });
}
recordRunTelemetryStep.maxRetries = 0;

async function recordBlockStatusesStep(payload: {
  runId: string;
  ticketKey: string;
  ticketTitle: string;
  ticketUrl: string;
  definitionVersion: number | null;
  definitionId: number | null;
  blockStatuses: Record<string, BlockRunState>;
}) {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { recordBlockStatuses } = await import("../lib/telemetry/run-telemetry.js");
  await recordBlockStatuses(getDb(), payload);
}
recordBlockStatusesStep.maxRetries = 0;

// --- Main Workflow ---

export async function agentWorkflow(input: string | AgentWorkflowInput) {
  "use workflow";

  const entry: AgentWorkflowInput =
    typeof input === "string" ? { kind: "ticket", ticketKey: input } : input;
  const ticketId = entry.ticketKey;

  const { workflowRunId } = getWorkflowMetadata();
  const budgetStartedAtMs = await readRunBudgetClockStep();

  const { env } = await import("../../env.js");
  const { assembleResearchPlanContext, assembleImplementationContext, assembleReviewContext } =
    await import("../sandbox/context.js");
  const { collectPhase, teardownSandboxes } =
    await import("../sandbox/poll-agent.js");
  const { publishWorkspaceChanges } = await import("./workspace-publication.js");
  const { formatUsageReport } = await import("../sandbox/usage.js");
  const { AGENT_SCHEMA, RESEARCH_SCHEMA, REVIEW_SCHEMA } = await import("../sandbox/agents/types.js");
  const backlogMoveTarget = (): IssueTrackerMoveTarget =>
    env.JIRA_BACKLOG_TRANSITION_ID
      ? { name: env.COLUMN_BACKLOG, transitionId: env.JIRA_BACKLOG_TRANSITION_ID }
      : env.COLUMN_BACKLOG;
  const aiReviewMoveTarget = (): IssueTrackerMoveTarget =>
    env.JIRA_AI_REVIEW_TRANSITION_ID
      ? { name: env.COLUMN_AI_REVIEW, transitionId: env.JIRA_AI_REVIEW_TRANSITION_ID }
      : env.COLUMN_AI_REVIEW;

  const ticket = await fetchAndValidateTicket(ticketId, env.COLUMN_AI, entry.kind !== "ticket");
  if (!ticket) return;

  // Re-pickup housekeeping (strip the awaiting-input label, supersede any pending
  // clarification, flip parked predecessor runs off "awaiting"). Gated to the
  // entry kinds that own the ticket's main work thread: a plain "ticket" pickup
  // and a "clarification_answered" resume. A pr_trigger / plan_approved run is a
  // PR/plan follow-up that must NOT touch the ticket's clarification state, so it
  // skips the whole step, including the label removal. All operations inside are
  // idempotent, so this is a safe no-op on a first pickup too.
  if (entryOwnsClarificationThread(entry.kind)) {
    await reconcileClarificationsOnPickup(
      ticket.identifier,
      workflowRunId,
      entry.kind === "clarification_answered" ? entry.clarificationRequestId : null,
    );
  }

  // First pickup only: post exactly one dashboard link comment so a human can
  // follow progress and answer questions. The link itself is the idempotency
  // marker (hasDashboardLinkComment), so a re-picked ticket that already has it
  // posts nothing. Ticket-triggered runs only: pr_trigger and plan_approved
  // runs are follow-ups on a ticket the bot already commented on.
  if (entry.kind === "ticket" && !hasDashboardLinkComment(ticket.comments, ticket.identifier)) {
    await postPickupCommentStep(ticket.identifier);
  }

  const { loadPrompts } = await import("./prompts-step.js");
  const prompts = await loadPrompts();

  const { loadWorkflowDefinitionFor } = await import("./definition-step.js");
  const entryTriggerType = triggerTypeFor(entry);
  // An approved plan pins the definition version that produced it, so the run
  // replays the exact graph the human reviewed rather than the current head.
  const pinnedVersion = "definitionVersion" in entry ? entry.definitionVersion : undefined;
  const plan = await loadWorkflowDefinitionFor(entryTriggerType, entry.definitionId, pinnedVersion);
  if (!plan) {
    console.warn(
      `No runnable workflow definition for trigger ${entryTriggerType}; skipping run for ${ticket.identifier}`,
    );
    return;
  }

  const budgetLimits: RunBudgetLimits = {
    maxDurationMs: plan.budgets?.maxDurationMs ?? env.JOB_TIMEOUT_MS,
    ...(plan.budgets?.maxTokens !== undefined ? { maxTokens: plan.budgets.maxTokens } : {}),
    ...(plan.budgets?.maxCostUsd !== undefined ? { maxCostUsd: plan.budgets.maxCostUsd } : {}),
  };
  let budgetState: RunBudgetState = createRunBudgetState();
  let lastBudgetClockMs = budgetStartedAtMs;
  const observeBudgetAtBoundary = async (
    requireRemainingDuration: boolean,
  ): Promise<RunBudgetObservation> => {
    const now = await readRunBudgetClockStep();
    budgetState = addActiveElapsed(budgetState, now - lastBudgetClockMs);
    lastBudgetClockMs = Math.max(lastBudgetClockMs, now);
    return observeRunBudget(budgetState, budgetLimits, requireRemainingDuration);
  };
  const enforceBudgetAtBoundary = async (requireRemainingDuration: boolean): Promise<void> => {
    const observation = await observeBudgetAtBoundary(requireRemainingDuration);
    if (observation.check.status !== "ok") throw new RunBudgetError(observation.check);
  };

  const blockStatuses: Record<string, BlockRunState> = Object.fromEntries(
    plan.nodes
      .filter((node) => !isTriggerBlockType(node.type))
      .map((node): [string, BlockRunState] => [node.id, { status: "pending" }]),
  );
  let currentBlockId: string | null = null;
  const writeBlockStatuses = () =>
    recordBlockStatusesStep({
      runId: workflowRunId,
      ticketKey: ticket.identifier,
      ticketTitle: ticket.title,
      ticketUrl: `${env.JIRA_BASE_URL.replace(/\/+$/, "")}/browse/${ticket.identifier}`,
      definitionVersion: plan.version,
      definitionId: plan.definitionId,
      blockStatuses: { ...blockStatuses },
    }).catch(() => {});
  await writeBlockStatuses();

  const phaseUsages: Record<string, PhaseUsage | null> = {};
  const phaseModels: Record<string, string> = {};
  // Phases whose agent was launched. A phase that times out or exits before
  // its usage is parsed never gets a phaseUsages entry; the finally reconciles
  // any such launched-but-missing phase to null so computeUsageTotals flags
  // costKnown=false instead of reporting a misleading costUsd=0 / costKnown=true.
  const launchedPhases = new Set<string>();
  const reconcileMissingPhaseUsages = (): void => {
    for (const phase of launchedPhases) {
      if (phase in phaseUsages) continue;
      phaseUsages[phase] = null;
      budgetState = recordBudgetUsage(budgetState, null, null);
    }
  };
  // Captured on the success path; written as run telemetry in the finally.
  let prForTelemetry: { url: string; number: number } | null = null;
  // Authoritative terminal status for telemetry, written in the finally on
  // every exit path. Defaults to "failed". The genuine PR-opened success flips
  // it to "success"; the clarification exits record "awaiting" (the run is
  // parked, not done: the answer endpoint or the re-pickup housekeeping later
  // flips it to success). Every phase failure / timeout / thrown error keeps
  // "failed".
  let runOutcome: "success" | "failed" | "awaiting" = "failed";
  let terminalBudgetFailure: RunBudgetFailure | null = null;
  // The clarification this run parked on, set only on the awaiting path. Threaded
  // into the terminal telemetry write so it can re-check the row and record
  // "success" instead of a phantom "awaiting" when the answer landed after the
  // park but before this finally.
  let awaitingClarificationId: string | null = null;
  // Seeded with the run default model once prepare_workspace provisions the
  // sandbox, then set to the implementation block's model once it runs.
  let activeModel: string | undefined;
  let priceLookup: ((m: string) => { input: number; cached_input: number; output: number } | null) | undefined;
  // Returns the formatted usage report when any phase has produced usage,
  // otherwise undefined so the messaging formatter can omit the trailing block.
  const usageReportOrUndefined = (): string | undefined =>
    Object.keys(phaseUsages).length
      ? formatUsageReport(phaseUsages, priceLookup, activeModel, phaseModels)
      : undefined;

  try {
    await notifyTicket(ticket.identifier, { kind: "started" });

    const graph = buildRuntimeGraph({ nodes: plan.nodes, edges: plan.edges });
    const entryTrigger = plan.nodes.find((node) => node.type === entryTriggerType);
    if (!entryTrigger || !graph.nodes.has(entryTrigger.id)) {
      throw new Error("workflow definition has no runnable trigger block");
    }
    const triggerOutput = triggerOutputFor(entry);

    const branchName = branchForTicket(ticket.identifier);
    const downloadedAttachments = await fetchAttachments(ticket.identifier, ticket.attachments);

    // Answered Q&A history for this ticket, injected into every prompt so a
    // resumed / re-picked run sees what a human already answered. Loaded for
    // every entry kind (a recovery or manual re-pickup is a plain "ticket" run,
    // and the answers live only in the DB). Best-effort: the step retries on a
    // transient DB error, but a persistent failure must degrade to no history
    // (a warn, not a dead run), so we log and continue with undefined.
    let clarificationHistory:
      | Array<{ questions: string[]; answer: string; answeredBy?: string; answeredAt?: string }>
      | undefined;
    try {
      clarificationHistory = await loadClarificationHistoryStep(ticket.identifier);
    } catch (err) {
      await logClarificationHistoryFailure(ticket.identifier, errorMessage(err));
      clarificationHistory = undefined;
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

    // Per-ticket agent override via labels (e.g. `agent:codex`). Falls
    // back to env.AGENT_KIND when the ticket has no override or the labels
    // are ambiguous (multiple distinct kinds).
    const agentKindOverride = await resolveAgentKindOverride(ticket.labels);
    // The run default drives blocks that don't pin a provider, plus the pre-PR
    // fix cycle and push fixes. Per-block overrides layer on top of it.
    const runDefaultKind: AgentKind = resolveRunDefaultKind(agentKindOverride, env.AGENT_KIND);

    const defaultModel = runDefaultKind === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL;
    const resolveAgent = (params: WorkflowDefinitionNode["params"]) =>
      resolveBlockAgent(params, runDefaultKind, { claude: env.CLAUDE_MODEL, codex: env.CODEX_MODEL });

    // Codex agents and every in-process Call LLM need token pricing. Fetch all
    // resolved models before any block can record usage so configured cost caps
    // fail closed instead of depending on network timing during execution.
    const pricedModels = modelsRequiringPriceLookup(plan.nodes, runDefaultKind, {
      claude: env.CLAUDE_MODEL,
      codex: env.CODEX_MODEL,
    });
    if (pricedModels.size > 0) {
      const priceMap = new Map<string, { input: number; cached_input: number; output: number }>();
      for (const model of pricedModels) {
        const price = await fetchModelPriceStep(model);
        if (price) priceMap.set(model, price);
      }
      const missingPriceFailure = missingRequiredPriceFailure(
        budgetLimits.maxCostUsd,
        pricedModels,
        priceMap,
      );
      if (missingPriceFailure) throw new RunBudgetError(missingPriceFailure);
      priceLookup = (model) => priceMap.get(model) ?? null;
    }

    const state = {
      runUnregisteredBeforePr: false,
      implementationModel: defaultModel,
      implementationKind: undefined as AgentKind | undefined,
      attempt: 1,
    };

    const ctx: EngineCtx = {
      runId: workflowRunId,
      definitionId: plan.definitionId,
      definitionVersion: plan.version,
      definitionNodes: plan.nodes,
      entry,
      ticket,
      ...(clarificationHistory && clarificationHistory.length > 0
        ? { clarifications: clarificationHistory }
        : {}),
      branchName,
      sandboxId: null,
      agentSandboxIds: {},
      sandboxIds: new Set<string>(),
      selectedRepositories: [],
      repositoryContexts: [],
      preSandboxAdditions: { research: [], implementation: [], review: [] },
      researchPlanMarkdown: entry.kind === "plan_approved" ? entry.approvedPlan.markdown : "",
      publication: null,
      runDefaultKind,
      defaults: { claude: env.CLAUDE_MODEL, codex: env.CODEX_MODEL },
      prompts,
      moveTargets: { backlog: backlogMoveTarget(), aiReview: aiReviewMoveTarget() },
      arthur: {
        taskId: null,
      },
      observeBudget: (requireRemainingDuration = true) =>
        observeBudgetAtBoundary(requireRemainingDuration),
      recordUsage: (label, usage, model) => {
        const key = phaseKey(label, state.attempt);
        phaseUsages[key] = usage;
        phaseModels[key] = model;
        budgetState = recordBudgetUsage(
          budgetState,
          usage,
          priceLookup?.(model) ?? null,
        );
      },
      markLaunched: (label) => {
        launchedPhases.add(phaseKey(label, state.attempt));
      },
      unregisterBeforePr: async () => {
        if (!state.runUnregisteredBeforePr) {
          await unregisterRun(ticket.identifier);
          state.runUnregisteredBeforePr = true;
        }
      },
    };

    try {
      const clarificationExit = async (
        questions: string[],
        nodeId?: string,
        suggestedAnswers?: string[],
      ): Promise<void> => {
        // Crash safety: with question comments gone, the questions must exist
        // durably BEFORE any ticket movement. This insert (maxRetries = 0)
        // throwing fails the run visibly; the outer catch then parks the ticket
        // in backlog like any other failure. Order after it mirrors every
        // terminal path: unregister BEFORE moveTicket (see failureExit's race
        // note), and park posts no Jira comment.
        const clarificationId = await createClarificationRequestStep({
          ticketKey: ticket.identifier,
          runId: workflowRunId,
          blockId: nodeId ?? null,
          definitionId: plan.definitionId,
          definitionVersion: plan.version,
          questions,
          suggestedAnswers: suggestedAnswers ?? null,
        });
        await unregisterRun(ticket.identifier);
        const parked = await parkForClarificationStep(ticketId, backlogMoveTarget(), clarificationId);
        if (!parked) {
          // The answer raced ahead of the park and already owns the ticket (moved
          // to the AI column, resume run started). No clarification is pending, so
          // send no notify and record this run as done, not awaiting.
          runOutcome = "success";
          return;
        }
        await notifyTicket(ticket.identifier, {
          kind: "needs_clarification",
          dashboardUrl: ticketRunUrl(env.DASHBOARD_ORIGIN, ticket.identifier, workflowRunId),
          usageReport: usageReportOrUndefined(),
        });
        awaitingClarificationId = clarificationId;
        runOutcome = "awaiting";
      };

      const failureExit = async (phase: string, reason: string): Promise<void> => {
        const usageReport = usageReportOrUndefined();
        await logPhaseFailure(ticket.identifier, phase, reason);
        // Unregister BEFORE moveTicket so the Jira webhook for this move
        // can't race ahead and fire a duplicate "canceled" notification
        // (the registry entry is what makes the webhook treat a finishing
        // run as a cancellable orphan). Same reasoning at every terminal
        // path below. open_pr's beforeCreatePullRequests may have already
        // unregistered after the push landed, so dedupe via the flag.
        if (!state.runUnregisteredBeforePr) {
          await unregisterRun(ticket.identifier);
        }
        await moveTicket(ticketId, backlogMoveTarget());
        const knownPhase = FAILURE_PHASES.has(phase) ? (phase as NotifyPhase) : undefined;
        await notifyTicket(ticket.identifier, {
          kind: "failed",
          ...(knownPhase ? { phase: knownPhase } : {}),
          reason,
          usageReport,
        });
      };

      const terminate = async (
        params: {
          terminalStatus: "waiting_for_human" | "failed" | "skipped" | "done";
          postComment?: string;
        },
        nodeId?: string,
      ): Promise<void> => {
        if (params.terminalStatus === "waiting_for_human") {
          // Same rework as clarificationExit: file the question durably FIRST
          // (before any unregister/move), then unregister -> park -> notify.
          // maxRetries = 0, so a throw fails the run and the outer catch parks
          // the ticket like any failure. No Jira comment.
          const clarificationId = await createClarificationRequestStep({
            ticketKey: ticket.identifier,
            runId: workflowRunId,
            blockId: nodeId ?? null,
            definitionId: plan.definitionId,
            definitionVersion: plan.version,
            questions: [params.postComment ?? "Waiting for human input."],
            suggestedAnswers: null,
          });
          // Unregister BEFORE the park's moveTicket (dedupe via the flag), so the
          // move's Jira webhook can't race ahead and fire a duplicate "canceled".
          if (!state.runUnregisteredBeforePr) {
            await unregisterRun(ticket.identifier);
            state.runUnregisteredBeforePr = true;
          }
          const parked = await parkForClarificationStep(ticketId, backlogMoveTarget(), clarificationId);
          if (!parked) {
            // The answer raced ahead of the park and already owns the ticket. No
            // clarification is pending, so send no notify and record success.
            runOutcome = "success";
            return;
          }
          await notifyTicket(ticket.identifier, {
            kind: "needs_clarification",
            dashboardUrl: ticketRunUrl(env.DASHBOARD_ORIGIN, ticket.identifier, workflowRunId),
            usageReport: usageReportOrUndefined(),
          });
          awaitingClarificationId = clarificationId;
          runOutcome = "awaiting";
          return;
        }
        // Non-clarification terminal statuses: unregister first (dedupe via the
        // flag), same race rationale as failureExit.
        if (!state.runUnregisteredBeforePr) {
          await unregisterRun(ticket.identifier);
          state.runUnregisteredBeforePr = true;
        }
        if (params.terminalStatus === "done" || params.terminalStatus === "skipped") {
          if (params.postComment) {
            await postTicketComment(ticket.identifier, params.postComment);
          }
          runOutcome = "success";
          return;
        }
        await moveTicket(ticketId, backlogMoveTarget());
        await notifyTicket(ticket.identifier, {
          kind: "failed",
          reason: params.postComment ?? "Terminated by workflow.",
          usageReport: usageReportOrUndefined(),
        });
        runOutcome = "failed";
      };

      const noWorkspace = (type: WorkflowBlockType): BlockExecutionResult => ({
        kind: "failed",
        output: { status: "failed" },
        reason: `no workspace: connect prepare_workspace before ${type}`,
      });

      const attachmentSandboxIds = new Set<string>();
      const writeAttachmentsOnce = async (sandboxId: string): Promise<void> => {
        if (attachmentSandboxIds.has(sandboxId)) return;
        await writeAttachments(sandboxId, downloadedAttachments);
        attachmentSandboxIds.add(sandboxId);
      };
      const ensureCodeWorkspace = async (): Promise<
        | { kind: "ready"; sandboxId: string }
        | { kind: "exit"; result: BlockExecutionResult }
      > => {
        const result = await ensureWorkspace(ctx);
        if (result.kind !== "next") return { kind: "exit", result };
        if (!ctx.sandboxId) return { kind: "exit", result: noWorkspace("prepare_workspace") };
        await writeAttachmentsOnce(ctx.sandboxId);
        return { kind: "ready", sandboxId: ctx.sandboxId };
      };

      const executeBlock: BlockExecutor = async (
        node,
        steps,
        resolvedInputs,
      ): Promise<BlockExecutionResult> => {
        const blockExecute = BLOCK_EXECUTORS[node.type];
        if (blockExecute) {
          const result = await blockExecute(node, steps, ctx, resolvedInputs);
          if (node.type === "prepare_workspace" && result.kind === "next" && ctx.sandboxId) {
            activeModel ??= defaultModel;
            await writeAttachmentsOnce(ctx.sandboxId);
          }
          return result;
        }

        switch (node.type) {
          case "planning_agent": {
            const researchPhase = phaseKey("Research", state.attempt);
            const { kind, model } = resolveAgent(node.params);
            const provisioned = await ensurePlanningAgentSandboxForBlock(ctx, kind, model);
            if (provisioned.kind === "failed") return provisioned;
            const sandboxId = provisioned.sandboxId;
            await writeAttachmentsOnce(sandboxId);
            phaseModels[researchPhase] = model;
            await setCommitGuardStep(sandboxId, kind, false);

            const { paths: researchPaths, script: researchScript } =
              await planPhaseStep(kind, "research", model, RESEARCH_SCHEMA);
            const researchInput = assembleResearchPlanContext({
              ticket: ticketData,
              prompt: prompts.research,
              branchName,
              attachments: downloadedAttachments,
              preSandboxAdditions: ctx.preSandboxAdditions.research,
              repositoryContexts: ctx.repositoryContexts,
            });

            const researchCommandId = await writeAndStartPhase(
              sandboxId,
              researchPaths.input, researchInput,
              researchPaths.wrapper, researchScript,
            );
            launchedPhases.add(researchPhase);

            const researchDone = await pollPhaseUntilDone(
              sandboxId,
              researchPaths.sentinel,
              20,
              researchCommandId,
              ctx.observeBudget,
            );
            if (!researchDone) {
              return { kind: "failed", output: { status: "failed" }, reason: "phase timed out", phase: "research" };
            }

            const { raw: researchRaw, structured: researchStructured } =
              await collectPhase(sandboxId, researchPaths);
            const { research, usage: researchUsage } =
              await parseResearchStep(kind, researchRaw, researchStructured);
            ctx.recordUsage("Research", researchUsage, model);

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
              return { kind: "failed", output: { status: "failed" }, reason, phase: "research" };
            }

            ctx.researchPlanMarkdown = research.body;
            return { kind: "next", output: { status: "ready", plan: research.body } };
          }

          case "implementation_agent": {
            const workspace = await ensureCodeWorkspace();
            if (workspace.kind === "exit") return workspace.result;
            const sandboxId = workspace.sandboxId;
            const implPhase = phaseKey("Impl", state.attempt);
            const { kind, model } = resolveAgent(node.params);
            phaseModels[implPhase] = model;
            state.implementationModel = model;
            state.implementationKind = kind;
            // Mixed-run telemetry: the run's headline model is the impl block's.
            activeModel = model;
            await setCommitGuardStep(sandboxId, kind, true);

            const { paths: implPaths, script: implScript } =
              await planPhaseStep(kind, "impl", model, AGENT_SCHEMA);
            const implInput = assembleImplementationContext({
              ticket: ticketData,
              prompt: prompts.implement,
              researchPlanMarkdown: ctx.researchPlanMarkdown,
              attachments: downloadedAttachments,
              preSandboxAdditions: ctx.preSandboxAdditions.implementation,
              selectedRepositories: ctx.selectedRepositories,
            });

            const implCommandId = await writeAndStartPhase(
              sandboxId,
              implPaths.input, implInput,
              implPaths.wrapper, implScript,
            );
            launchedPhases.add(implPhase);

            const implDone = await pollPhaseUntilDone(
              sandboxId,
              implPaths.sentinel,
              35,
              implCommandId,
              ctx.observeBudget,
            );
            let implOutput: AgentOutput;

            if (implDone) {
              const { raw: implRaw, structured: implStructured } = await collectPhase(sandboxId, implPaths);
              const { output, usage: implUsage } = await parseAgentOutputStep(kind, implRaw, implStructured);
              ctx.recordUsage("Impl", implUsage, model);
              implOutput = output;
            } else {
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
              return { kind: "failed", output: { status: "failed" }, reason, phase: "impl" };
            }

            return { kind: "next", output: { status: "implemented" } };
          }

          case "review_agent": {
            const workspace = await ensureCodeWorkspace();
            if (workspace.kind === "exit") return workspace.result;
            const sandboxId = workspace.sandboxId;
            const reviewPhase = phaseKey("Review", state.attempt);
            const { kind, model } = resolveAgent(node.params);
            phaseModels[reviewPhase] = model;
            // Install the review provider's commit guard: in a mixed run it may
            // differ from impl's provider, so its guard was never set up.
            await setCommitGuardStep(sandboxId, kind, true);
            const { paths: reviewPaths, script: reviewScript } =
              await planPhaseStep(kind, "review", model, REVIEW_SCHEMA);
            const reviewInput = assembleReviewContext({
              ticket: ticketData,
              prompt: prompts.review,
              researchPlanMarkdown: ctx.researchPlanMarkdown,
              attachments: downloadedAttachments,
              preSandboxAdditions: ctx.preSandboxAdditions.review,
              selectedRepositories: ctx.selectedRepositories,
            });

            const reviewCommandId = await writeAndStartPhase(
              sandboxId,
              reviewPaths.input, reviewInput,
              reviewPaths.wrapper, reviewScript,
            );
            launchedPhases.add(reviewPhase);

            const reviewDone = await pollPhaseUntilDone(
              sandboxId,
              reviewPaths.sentinel,
              15,
              reviewCommandId,
              ctx.observeBudget,
            );
            let reviewOutput: ReviewOutput;

            if (reviewDone) {
              const { raw: reviewRaw, structured: reviewStructured } = await collectPhase(sandboxId, reviewPaths);
              const { output, usage: reviewUsage } = await parseReviewStep(kind, reviewRaw, reviewStructured);
              ctx.recordUsage("Review", reviewUsage, model);
              reviewOutput = output;
            } else {
              reviewOutput = { result: "failed", feedback: "", issues: [], error: "Review phase timed out" };
            }

            if (reviewOutput.result === "failed") {
              const reason = reviewOutput.error ?? "unknown";
              const feedback = reviewOutput.feedback.trim();
              return {
                kind: "failed",
                output: { status: "failed", ...(feedback ? { feedback } : {}) },
                reason,
                phase: "review",
              };
            }

            const feedback = reviewOutput.feedback.trim();
            return { kind: "next", output: { status: "ok", ...(feedback ? { feedback } : {}) } };
          }

          case "run_pre_pr_checks": {
            if (!ctx.sandboxId) return noWorkspace(node.type);
            const maxFixCycles =
              typeof node.params.maxFixCycles === "number" ? node.params.maxFixCycles : undefined;
            const budget = await ctx.observeBudget();
            if (budget.check.status !== "ok") throw new RunBudgetError(budget.check);
            let prePrChecks: Awaited<ReturnType<typeof runPrePrChecksStep>>;
            try {
              prePrChecks = await runPrePrChecksStep(
                ctx.sandboxId,
                state.implementationKind ?? runDefaultKind,
                state.implementationModel,
                maxFixCycles,
                Math.max(1, Math.floor(budget.remainingDurationMs)),
                {
                  state: budgetState,
                  limits: budgetLimits,
                  price: priceLookup?.(state.implementationModel) ?? null,
                },
              );
            } catch (err) {
              if (err instanceof RunBudgetError) throw err;
              const after = await ctx.observeBudget();
              if (after.check.status !== "ok") throw new RunBudgetError(after.check);
              if (isDurationAbortError(err)) {
                throw new RunBudgetError(durationBudgetFailure(after, "Pre-PR checks"));
              }
              throw err;
            }
            recordPrePrFixCycleUsages(
              ctx,
              prePrChecks.fixCycleUsages,
              state.implementationModel,
              prePrChecks.budgetFailure,
            );
            if (!prePrChecks.passed) {
              return {
                kind: "failed",
                output: {
                  status: "failed",
                  ok: false,
                  fixCycles: prePrChecks.fixCycles,
                  summary: prePrChecks.summary,
                },
                reason: prePrChecks.summary,
                phase: "pre-pr-checks",
              };
            }
            return {
              kind: "next",
              output: {
                status: "ok",
                ok: true,
                fixCycles: prePrChecks.fixCycles,
                summary: prePrChecks.summary,
              },
            };
          }

          case "open_pr": {
            if (!ctx.sandboxId) return noWorkspace(node.type);
            state.runUnregisteredBeforePr = false;
            const publication = await publishWorkspaceChanges({
              sandboxId: ctx.sandboxId,
              ticketKey: ticket.identifier,
              branchName,
              repositories: ctx.selectedRepositories,
              title: ticket.title,
              agentKind: state.implementationKind ?? runDefaultKind,
              model: state.implementationModel,
              clarifications: ticketData.clarifications,
              beforeCreatePullRequests: async () => {
                // Push has landed. Unregister BEFORE any downstream step that can
                // trigger a Jira webhook: opening a PR can transition the linked
                // issue (GitHub-for-Jira / Jira automation), and our own moveTicket
                // fires a webhook for the AI -> AI Review move. Either webhook, if
                // it sees a still-registered run, will call cancelRun and emit a
                // spurious "canceled" notification on top of "pr_ready". Clearing
                // the registry here closes that window.
                await ctx.unregisterBeforePr();
              },
            });
            ctx.publication = publication;

            if (publication.status === "failed") {
              // The terminal unregister/move/notify runs in failureExit; keep only
              // the bespoke bookkeeping here. failureExit dedupes the unregister via
              // state.runUnregisteredBeforePr, set above when the push landed.
              if (publication.prs.length > 0) {
                await postPrLinksComment(
                  ticket.identifier,
                  publication.prs,
                  "Pull requests created before publication failed:",
                );
              }
              return {
                kind: "failed",
                output: { status: "failed" },
                reason: publication.reason,
                phase: "push",
              };
            }

            if (publication.prs.some((pr) => pr.isNew)) {
              await postPrLinksComment(ticket.identifier, publication.prs);
            }

            const primaryPr = publication.prs[0]!;
            prForTelemetry = { url: primaryPr.url, number: primaryPr.id };
            return {
              kind: "next",
              output: { status: "ok", prUrl: primaryPr.url, prNumber: primaryPr.id },
            };
          }

          case "send_slack_message": {
            const publication = ctx.publication;
            if (publication?.status === "published") {
              const primaryPr = publication.prs[0]!;
              const usageReport = formatUsageReport(phaseUsages, priceLookup, activeModel, phaseModels);
              const message = resolveSlackMessageInput(node.params, resolvedInputs);
              await notifyTicket(ticket.identifier, {
                kind: "pr_ready",
                pr: { url: primaryPr.url, number: primaryPr.id },
                usageReport,
                ...(message ? { extraText: message } : {}),
              });
              return { kind: "next", output: { status: "ok" } };
            }
            return { kind: "next", output: { status: "skipped" } };
          }

          case "update_ticket_status": {
            const targetName = resolveTicketStatusInput(node.params, resolvedInputs);
            const target = targetName === "backlog" ? backlogMoveTarget() : aiReviewMoveTarget();
            await moveTicket(ticketId, target);
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

      const hooks: ExecuteGraphHooks = {
        async onBlockStart(nodeId, attempt) {
          currentBlockId = nodeId;
          state.attempt = attempt;
          blockStatuses[nodeId] = { status: "running", attempt };
          await writeBlockStatuses();
          await enforceBudgetAtBoundary(true);
        },
        async onBlockFinish(nodeId, state) {
          reconcileMissingPhaseUsages();
          await enforceBudgetAtBoundary(false);
          let guarded = state;
          if (state.output && JSON.stringify(state.output).length > 8192) {
            guarded = { ...state, output: { status: state.output.status, _truncated: true } };
          }
          blockStatuses[nodeId] = guarded;
          await writeBlockStatuses();
        },
        clarificationExit,
        failureExit,
        terminate,
      };

      const walk = await executeGraph({
        graph,
        entryTriggerId: entryTrigger.id,
        triggerOutput,
        runValues: {
          id: workflowRunId,
          branchName,
          defaultAgent: { provider: runDefaultKind, model: defaultModel },
        },
        executeBlock,
        hooks,
        maxTotalExecutions: 200,
      });
      // "ended" is a clean awaiting stop (e.g. send_plan_approval parked the
      // run for human approval and already moved the ticket): a success, not a
      // failure. No ticket move here; the block owns that.
      // Constraint: never promote a clarification park to success here. The
      // terminate/clarification paths set runOutcome = "awaiting" and own it
      // (the answer endpoint flips it later), so a completed/ended walk that
      // left "awaiting" set must keep it. The `as string` read is needed
      // because TS can't see the hook closures writing runOutcome and narrows
      // it to its "failed" initializer.
      if (
        (walk.outcome === "completed" || walk.outcome === "ended") &&
        (runOutcome as string) !== "awaiting"
      ) {
        currentBlockId = null;
        runOutcome = "success";
      }
    } finally {
      // Tear down EVERY sandbox the run created, not just the latest
      // ctx.sandboxId: a prepare_workspace inside a loop provisions a fresh
      // sandbox each iteration, and all but the last would otherwise leak.
      await teardownSandboxes(ctx.sandboxIds);
    }
  } catch (caught) {
    reconcileMissingPhaseUsages();
    let err = caught;
    if (!(err instanceof RunBudgetError)) {
      const observation = await observeBudgetAtBoundary(false);
      if (observation.check.status !== "ok") err = new RunBudgetError(observation.check);
    }
    if (err instanceof RunBudgetError) terminalBudgetFailure = err.failure;
    if (currentBlockId) {
      blockStatuses[currentBlockId] = {
        status: "fail",
        error: truncateError((err as Error).message ?? "unknown"),
      };
      await writeBlockStatuses();
    }
    console.error(`Workflow failed for ${ticket.identifier}:`, err);
    // Unregister BEFORE the move so the move's webhook can't race ahead and
    // fire a duplicate "canceled" notification on top of the "failed" one.
    // If the move then fails, markTicketFailed re-records a marker that
    // dispatch.isTicketFailed checks to keep the ticket from being re-picked.
    // runId-scoped: only clears this run's own row, so an uncaught throw after
    // open_pr freed the slot can't stomp a successor pr_trigger that claimed it.
    await unregisterRunIfCurrent(ticket.identifier, workflowRunId).catch(() => {});
    const moved = await moveTicket(ticketId, backlogMoveTarget()).then(() => true).catch(() => false);
    await notifyTicket(ticket.identifier, {
      kind: "failed",
      reason: (err as Error).message ?? "unknown",
      usageReport: usageReportOrUndefined(),
    }).catch(() => {});
    if (!moved) {
      await markTicketFailed(ticket.identifier, `Failed to move ticket to backlog: ${(err as Error).message ?? "unknown"}`).catch(() => {});
    }
    throw err;
  } finally {
    // A launched phase with no parsed usage (timed out / errored before
    // collect) records as unknown, so computeUsageTotals reports
    // costKnown=false instead of a misleading costUsd=0 / costKnown=true.
    reconcileMissingPhaseUsages();
    // Free the ticket's active_runs slot on every terminal exit. Most paths
    // (open_pr, finalize_workspace, send_plan_approval, terminate, clarification,
    // failure) already unregister mid-run, but a graph that completes without any
    // of them (e.g. a PR-review flow that only posts a comment) would otherwise
    // leave a stale row registered until reconcile's cron sweeps it — and that
    // row coalesces the ticket's NEXT pr_trigger at claim() (a PR legitimately
    // gets both a checks-failed and a review).
    //
    // Scope the release to THIS run's id: a run that unregistered mid-flight
    // (open_pr/finalize before creating the PR) can have its ticket reclaimed by
    // a successor pr_trigger run that PR creation dispatches. A bare unregister
    // deletes by ticketKey and would stomp that successor's still-live row,
    // yielding two concurrent runs for one ticket. unregisterIfRunId only deletes
    // when the row still holds workflowRunId, so a stomp is a harmless no-op.
    await unregisterRunIfCurrent(ticket.identifier, workflowRunId).catch(() => {});
    // Durable cost/usage telemetry, recorded on every exit path (success,
    // clarification, or failure). Best-effort: the step never retries and we
    // swallow errors so telemetry can't break or delay the run — but we LOG
    // the failure so a silent break (e.g. a schema drift like a missing column
    // on the run's Neon branch) surfaces immediately instead of dropping run
    // history for days unnoticed.
    await recordRunTelemetryStep({
      runId: workflowRunId,
      status: runOutcome,
      ticketKey: ticket.identifier,
      ticketTitle: ticket.title,
      ticketUrl: `${env.JIRA_BASE_URL.replace(/\/+$/, "")}/browse/${ticket.identifier}`,
      model: activeModel ?? null,
      totals: computeUsageTotals(phaseUsages, priceLookup, activeModel, phaseModels),
      budgetFailure: terminalBudgetFailure,
      pr: prForTelemetry,
      awaitingClarificationId,
    }).catch((err) => {
      console.error(
        `Run telemetry failed to persist for ${ticket.identifier} (run ${workflowRunId}):`,
        err,
      );
    });
  }
}
