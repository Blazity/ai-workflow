import { sleep, getWorkflowMetadata } from "workflow";
import { branchForTicket } from "../lib/branch-prefix.js";
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
import { resolveBlockAgent } from "../workflow-definition/resolve-agent.js";
import type { AgentWorkflowInput } from "./agent-input.js";
import type { BlockExecuteFn, EngineCtx } from "./blocks/types.js";
import { execute as executePrepareWorkspace } from "./blocks/prepare-workspace.js";
import { execute as executeFinalizeWorkspace } from "./blocks/finalize-workspace.js";
import { execute as executeFixAgent } from "./blocks/fix-agent.js";
import { execute as executeGenericAgent } from "./blocks/generic-agent.js";
import { execute as executeCallLlm } from "./blocks/call-llm.js";
import { execute as executeFetchPrContext } from "./blocks/fetch-pr-context.js";
import { execute as executeRunChecks } from "./blocks/run-checks.js";
import { execute as executePostTicketComment } from "./blocks/post-ticket-comment.js";
import { execute as executePostPrComment } from "./blocks/post-pr-comment.js";
import { execute as executeHumanQuestion } from "./blocks/human-question.js";
import { execute as executeArthurInjectionCheck } from "./blocks/arthur-injection-check.js";
import { execute as executeArthurTrace } from "./blocks/arthur-trace.js";
import { isTriggerBlockType } from "@shared/contracts";
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
  arthur_trace: executeArthurTrace,
};

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
): Promise<void> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../sandbox/credentials.js");

  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

  await sandbox.writeFiles([
    { path: inputFilePath, content: Buffer.from(inputContent) },
    { path: scriptPath, content: Buffer.from(scriptContent) },
  ]);
  await sandbox.runCommand("chmod", ["+x", scriptPath]);

  await sandbox.runCommand({
    cmd: "bash",
    args: [scriptPath],
    cwd: "/vercel/sandbox",
    detached: true,
  });
}
writeAndStartPhase.maxRetries = 0;

async function fetchCodexPriceStep(model: string): Promise<{ input: number; cached_input: number; output: number } | null> {
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
fetchCodexPriceStep.maxRetries = 0;

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

async function postClarificationAndMoveBack(
  ticketId: string,
  questions: string[],
  backlogTarget: IssueTrackerMoveTarget,
): Promise<string | null> {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { NEEDS_CLARIFICATION_LABEL } = await import("../lib/labels.js");
  const { issueTracker } = createStepAdapters();
  const comment = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  const commentUrl = await issueTracker.postComment(ticketId, comment);
  // Tag the ticket so the overview's awaiting-input scan can find it cheaply.
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
  return commentUrl;
}

async function clearClarificationLabel(ticketId: string) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { NEEDS_CLARIFICATION_LABEL } = await import("../lib/labels.js");
  const { issueTracker } = createStepAdapters();
  if (typeof issueTracker.updateLabels === "function") {
    try {
      await issueTracker.updateLabels(ticketId, {
        remove: [NEEDS_CLARIFICATION_LABEL],
      });
    } catch (err) {
      const { logger } = await import("../lib/logger.js");
      logger.warn(
        { ticketId, err: errorMessage(err) },
        "clarification_label_remove_failed",
      );
    }
  }
}

async function unregisterRun(ticketIdentifier: string) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { runRegistry } = createStepAdapters();
  await runRegistry.unregister(ticketIdentifier);
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
): Promise<{ passed: boolean; fixCycles: number; summary: string }> {
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
  status: "success" | "failed";
  ticketKey: string;
  ticketTitle: string;
  ticketUrl: string;
  model: string | null;
  totals: UsageTotals;
  pr: { url: string; number: number } | null;
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
  await recordRunUsage(getDb(), {
    runId: payload.runId,
    // This is the agent workflow — its canonical identity (mirrors
    // WORKFLOW_MAP.agentWorkflow in lib/overview/collect-runs.ts). Recorded here
    // so the run is attributed even when no cron snapshot ever observes it.
    workflowId: "wf_agent",
    workflowName: "Agent",
    status: payload.status,
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

// --- Polling helper (not a step — called within the workflow) ---

async function pollUntilDone(
  sandboxId: string,
  sentinelFile: string,
  maxPollMinutes: number,
): Promise<boolean> {
  const { checkPhaseDone } = await import("../sandbox/poll-agent.js");
  const POLL_INTERVAL = "30s";
  const MAX_POLLS = Math.ceil((maxPollMinutes * 60) / 30);
  let pollCount = 0;

  while (pollCount < MAX_POLLS) {
    await sleep(POLL_INTERVAL);
    pollCount++;
    const status = await checkPhaseDone(sandboxId, sentinelFile);
    if (status === true) return true;
    if (status === "stopped") return false;
  }
  return false;
}

// --- Main Workflow ---

export async function agentWorkflow(input: string | AgentWorkflowInput) {
  "use workflow";

  const entry: AgentWorkflowInput =
    typeof input === "string" ? { kind: "ticket", ticketKey: input } : input;
  const ticketId = entry.ticketKey;

  const { workflowRunId } = getWorkflowMetadata();

  const { env } = await import("../../env.js");
  const { assembleResearchPlanContext, assembleImplementationContext, assembleReviewContext } =
    await import("../sandbox/context.js");
  const { collectPhase, teardownSandbox } =
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

  // Re-picked from backlog after a human answered a clarification: clear the
  // awaiting-input marker so the overview stops listing it (and a later failure
  // back to backlog can't resurface it as "awaiting").
  const { NEEDS_CLARIFICATION_LABEL } = await import("../lib/labels.js");
  if (ticket.labels.includes(NEEDS_CLARIFICATION_LABEL)) {
    await clearClarificationLabel(ticket.identifier);
  }

  const { loadPrompts } = await import("./prompts-step.js");
  const prompts = await loadPrompts();

  const { loadWorkflowDefinitionFor } = await import("./definition-step.js");
  const entryTriggerType = triggerTypeFor(entry);
  const plan = await loadWorkflowDefinitionFor(entryTriggerType, entry.definitionId);
  if (!plan) {
    console.warn(
      `No runnable workflow definition for trigger ${entryTriggerType}; skipping run for ${ticket.identifier}`,
    );
    return;
  }

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
  // Captured on the success path; written as run telemetry in the finally.
  let prForTelemetry: { url: string; number: number } | null = null;
  // Authoritative terminal status for telemetry, written in the finally on
  // every exit path. Defaults to "failed"; only the genuine PR-opened success
  // and the clarification exits (which complete cleanly) flip it to "success".
  // Every phase failure / timeout / thrown error keeps "failed".
  let runOutcome: "success" | "failed" = "failed";
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

    const ticketData = {
      identifier: ticket.identifier,
      title: ticket.title,
      description: ticket.description,
      acceptanceCriteria: ticket.acceptanceCriteria,
      comments: ticket.comments,
      labels: ticket.labels,
    };

    // Per-ticket agent override via labels (e.g. `agent:codex`). Falls
    // back to env.AGENT_KIND when the ticket has no override or the labels
    // are ambiguous (multiple distinct kinds).
    const agentKindOverride = await resolveAgentKindOverride(ticket.labels);
    // The run default drives blocks that don't pin a provider, plus the pre-PR
    // fix cycle and push fixes. Per-block overrides layer on top of it.
    const runDefaultKind: AgentKind = agentKindOverride ?? env.AGENT_KIND;

    const defaultModel = runDefaultKind === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL;
    const resolveAgent = (params: WorkflowDefinitionNode["params"]) =>
      resolveBlockAgent(params, runDefaultKind, { claude: env.CLAUDE_MODEL, codex: env.CODEX_MODEL });

    // Codex phases are priced from tokens, so gather every codex-resolved model
    // (plus the default codex model when the run default is codex, for fix
    // cycles). Claude-only runs leave priceLookup undefined.
    const codexModels = new Set<string>();
    for (const node of plan.nodes) {
      if (
        node.type === "planning_agent" ||
        node.type === "implementation_agent" ||
        node.type === "review_agent" ||
        node.type === "fix_agent" ||
        node.type === "generic_agent"
      ) {
        const resolved = resolveAgent(node.params);
        if (resolved.kind === "codex") codexModels.add(resolved.model);
      }
    }
    if (runDefaultKind === "codex") codexModels.add(env.CODEX_MODEL);
    if (codexModels.size > 0) {
      const priceMap = new Map<string, { input: number; cached_input: number; output: number }>();
      for (const model of codexModels) {
        const price = await fetchCodexPriceStep(model);
        if (price) priceMap.set(model, price);
      }
      priceLookup = (model) => priceMap.get(model) ?? null;
    }

    const arthurTraceParams = plan.nodes.find((node) => node.type === "arthur_trace")?.params;
    const arthurTaskNameOverride =
      typeof arthurTraceParams?.taskName === "string" && arthurTraceParams.taskName.trim().length > 0
        ? arthurTraceParams.taskName.trim()
        : undefined;

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
      branchName,
      sandboxId: null,
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
        ...(arthurTaskNameOverride !== undefined ? { taskNameOverride: arthurTaskNameOverride } : {}),
      },
      recordUsage: (label, usage, model) => {
        const key = phaseKey(label, state.attempt);
        phaseUsages[key] = usage;
        phaseModels[key] = model;
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
      const clarificationExit = async (questions: string[]): Promise<void> => {
        await unregisterRun(ticket.identifier);
        const commentUrl = await postClarificationAndMoveBack(
          ticketId,
          questions,
          backlogMoveTarget(),
        );
        await notifyTicket(ticket.identifier, {
          kind: "needs_clarification",
          commentUrl: commentUrl ?? undefined,
          usageReport: usageReportOrUndefined(),
        });
        runOutcome = "success";
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

      const terminate = async (params: {
        terminalStatus: "waiting_for_human" | "failed" | "skipped" | "done";
        postComment?: string;
      }): Promise<void> => {
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
        if (params.terminalStatus === "waiting_for_human") {
          const commentUrl = await postClarificationAndMoveBack(
            ticketId,
            [params.postComment ?? "Waiting for human input."],
            backlogMoveTarget(),
          );
          await notifyTicket(ticket.identifier, {
            kind: "needs_clarification",
            commentUrl: commentUrl ?? undefined,
            usageReport: usageReportOrUndefined(),
          });
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

      const executeBlock: BlockExecutor = async (node, steps): Promise<BlockExecutionResult> => {
        const blockExecute = BLOCK_EXECUTORS[node.type];
        if (blockExecute) {
          const result = await blockExecute(node, steps, ctx);
          if (node.type === "prepare_workspace" && result.kind === "next" && ctx.sandboxId) {
            activeModel ??= defaultModel;
            await writeAttachments(ctx.sandboxId, downloadedAttachments);
          }
          return result;
        }

        switch (node.type) {
          case "planning_agent": {
            if (!ctx.sandboxId) return noWorkspace(node.type);
            const sandboxId = ctx.sandboxId;
            const researchPhase = phaseKey("Research", state.attempt);
            const { kind, model } = resolveAgent(node.params);
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

            await writeAndStartPhase(
              sandboxId,
              researchPaths.input, researchInput,
              researchPaths.wrapper, researchScript,
            );
            launchedPhases.add(researchPhase);

            const researchDone = await pollUntilDone(sandboxId, researchPaths.sentinel, 20);
            if (!researchDone) {
              return { kind: "failed", output: { status: "failed" }, reason: "phase timed out", phase: "research" };
            }

            const { raw: researchRaw, structured: researchStructured } =
              await collectPhase(sandboxId, researchPaths);
            const { research, usage: researchUsage } =
              await parseResearchStep(kind, researchRaw, researchStructured);
            phaseUsages[researchPhase] = researchUsage;

            if (research.status === "clarification_needed") {
              const parsed = research.body.split("\n").filter((l) => /^\d+\./.test(l.trim()));
              const questions = parsed.length > 0 ? parsed : [research.body];
              return {
                kind: "needs_human_input",
                output: { status: "needs_human_input", questions },
                questions,
              };
            }

            if (research.status === "failed") {
              const reason = research.body.slice(0, 200);
              return { kind: "failed", output: { status: "failed" }, reason, phase: "research" };
            }

            ctx.researchPlanMarkdown = research.body;
            return { kind: "next", output: { status: "ready", plan: research.body } };
          }

          case "implementation_agent": {
            if (!ctx.sandboxId) return noWorkspace(node.type);
            const sandboxId = ctx.sandboxId;
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

            await writeAndStartPhase(
              sandboxId,
              implPaths.input, implInput,
              implPaths.wrapper, implScript,
            );
            launchedPhases.add(implPhase);

            const implDone = await pollUntilDone(sandboxId, implPaths.sentinel, 35);
            let implOutput: AgentOutput;

            if (implDone) {
              const { raw: implRaw, structured: implStructured } = await collectPhase(sandboxId, implPaths);
              const { output, usage: implUsage } = await parseAgentOutputStep(kind, implRaw, implStructured);
              phaseUsages[implPhase] = implUsage;
              implOutput = output;
            } else {
              implOutput = { result: "failed", error: "Implementation phase timed out" };
            }

            if (implOutput.result === "clarification_needed") {
              const questions = implOutput.questions ?? [];
              return {
                kind: "needs_human_input",
                output: { status: "needs_human_input", questions },
                questions,
              };
            }

            if (implOutput.result === "failed") {
              const reason = implOutput.error ?? "unknown";
              return { kind: "failed", output: { status: "failed" }, reason, phase: "impl" };
            }

            return { kind: "next", output: { status: "implemented" } };
          }

          case "review_agent": {
            if (!ctx.sandboxId) return noWorkspace(node.type);
            const sandboxId = ctx.sandboxId;
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

            await writeAndStartPhase(
              sandboxId,
              reviewPaths.input, reviewInput,
              reviewPaths.wrapper, reviewScript,
            );
            launchedPhases.add(reviewPhase);

            const reviewDone = await pollUntilDone(sandboxId, reviewPaths.sentinel, 15);
            let reviewOutput: ReviewOutput;

            if (reviewDone) {
              const { raw: reviewRaw, structured: reviewStructured } = await collectPhase(sandboxId, reviewPaths);
              const { output, usage: reviewUsage } = await parseReviewStep(kind, reviewRaw, reviewStructured);
              phaseUsages[reviewPhase] = reviewUsage;
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
            const prePrChecks = await runPrePrChecksStep(
              ctx.sandboxId,
              state.implementationKind ?? runDefaultKind,
              state.implementationModel,
              maxFixCycles,
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
              const message =
                typeof node.params.message === "string" ? node.params.message.trim() : "";
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
            const targetName = node.params.target === "backlog" ? "backlog" : "ai_review";
            const target = targetName === "backlog" ? backlogMoveTarget() : aiReviewMoveTarget();
            await moveTicket(ticketId, target);
            return { kind: "next", output: { status: "ok", target: targetName } };
          }

          default:
            return { kind: "next", output: { status: "ok" } };
        }
      };

      const hooks: ExecuteGraphHooks = {
        async onBlockStart(nodeId, attempt) {
          currentBlockId = nodeId;
          state.attempt = attempt;
          blockStatuses[nodeId] = { status: "running", attempt };
          await writeBlockStatuses();
        },
        async onBlockFinish(nodeId, state) {
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
        executeBlock,
        hooks,
        maxTotalExecutions: 200,
      });
      if (walk.outcome === "completed") {
        currentBlockId = null;
        runOutcome = "success";
      }
    } finally {
      if (ctx.sandboxId) {
        await teardownSandbox(ctx.sandboxId);
      }
    }
  } catch (err) {
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
    await unregisterRun(ticket.identifier).catch(() => {});
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
    for (const phase of launchedPhases) {
      if (!(phase in phaseUsages)) phaseUsages[phase] = null;
    }
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
      pr: prForTelemetry,
    }).catch((err) => {
      console.error(
        `Run telemetry failed to persist for ${ticket.identifier} (run ${workflowRunId}):`,
        err,
      );
    });
  }
}
