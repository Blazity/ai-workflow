import { sleep, getWorkflowMetadata } from "workflow";
import { branchForTicket } from "../lib/branch-prefix.js";
import { computeUsageTotals, type UsageTotals } from "../sandbox/usage.js";
import type {
  AgentOutput, PhaseUsage, PhaseKind, PhaseArtifactPaths, ResearchResult, ReviewOutput,
} from "../sandbox/agents/types.js";
import type { AgentKind } from "../sandbox/agents/index.js";
import type { PRComment, CheckRunResult } from "../adapters/vcs/types.js";
import type {
  IssueTrackerMoveTarget,
  TicketAttachment,
} from "../adapters/issue-tracker/types.js";
import type { TicketEvent } from "../adapters/messaging/types.js";
import type { DownloadedAttachment } from "../sandbox/attachments.js";
import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";
import type { SelectedRepositoryPromptContext } from "../sandbox/context.js";
import type { WorkspaceRepositoryInput } from "../sandbox/repo-workspace.js";
import type { OrderedBlock } from "../workflow-definition/plan.js";
import type { WorkspacePublicationResult } from "./workspace-publication.js";

type PreSandboxPromptTarget = "research" | "implementation" | "review";

interface PreSandboxPromptAddition {
  target: PreSandboxPromptTarget[];
  title: string;
  content: string;
}

interface GroupedPreSandboxPromptAdditions {
  research?: PreSandboxPromptAddition[];
  implementation?: PreSandboxPromptAddition[];
  review?: PreSandboxPromptAddition[];
}

interface PreSandboxPhaseContext {
  ticket: {
    identifier: string;
    title: string;
    description: string;
    acceptanceCriteria: string;
    comments: Array<{ author: string; body: string; createdAt?: string }>;
    labels: string[];
  };
  run: {
    branchName: string;
  };
}

type PreSandboxPhaseResult =
  | {
      status: "continue";
      promptAdditions?: GroupedPreSandboxPromptAdditions;
      selectedRepositories?: SelectedRepository[];
    }
  | {
      status: "halt";
      outcome: "needs_clarification" | "failed";
      message: string;
      questions?: string[];
      promptAdditions?: GroupedPreSandboxPromptAdditions;
      selectedRepositories?: SelectedRepository[];
    };

// --- Step Functions ---

async function fetchAndValidateTicket(ticketId: string, columnAi: string) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { issueTracker } = createStepAdapters();
  const ticket = await issueTracker.fetchTicket(ticketId);
  if (ticket.trackerStatus.toLowerCase() !== columnAi.toLowerCase()) return null;
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

async function runPreSandboxPhaseStep(
  context: PreSandboxPhaseContext,
): Promise<PreSandboxPhaseResult> {
  "use step";
  const { runPreSandboxPhase } = await import("../pre-sandbox/runner.js");
  return runPreSandboxPhase(context);
}
runPreSandboxPhaseStep.maxRetries = 0;

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

async function fetchSelectedRepositoryPRContexts(
  repositories: SelectedRepository[],
): Promise<SelectedRepositoryPromptContext[]> {
  "use step";
  const { createRepositoryVCS } = await import("../lib/vcs-runtime.js");

  return Promise.all(repositories.map(async (repo) => {
    const pr = repo.workflowOwnedBranch?.pr;
    if (!pr) {
      return {
        repository: repo,
        prComments: [],
        checkResults: [],
        hasConflicts: false,
      };
    }
    const vcs = createRepositoryVCS({
      provider: repo.provider,
      repoPath: repo.repoPath,
      baseBranch: repo.defaultBranch,
    });
    const [prComments, checkResults, hasConflicts] = await Promise.all([
      vcs.getPRComments(pr.id),
      vcs.getCheckRunResults(pr.id),
      vcs.getPRConflictStatus(pr.id),
    ]);
    return {
      repository: repo,
      prComments,
      checkResults,
      hasConflicts,
    };
  }));
}

async function ensureArthurTaskForTicket(
  ticketIdentifier: string,
): Promise<string | null> {
  "use step";
  const { env } = await import("../../env.js");
  if (!env.GENAI_ENGINE_API_KEY || !env.GENAI_ENGINE_TRACE_ENDPOINT) return null;

  const { logger } = await import("../lib/logger.js");
  const { ArthurClient } = await import("../sandbox/arthur-client.js");
  const client = ArthurClient.fromTraceEndpoint(env.GENAI_ENGINE_TRACE_ENDPOINT, env.GENAI_ENGINE_API_KEY);
  try {
    const task = await client.ensureTaskForTicket(ticketIdentifier);
    logger.info({ taskId: task.id, taskName: task.name, ticketIdentifier }, "arthur_task_created");
    return task.id;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, ticketIdentifier },
      "arthur_task_create_failed",
    );
    return null;
  }
}
ensureArthurTaskForTicket.maxRetries = 0;

async function provisionSandbox(
  branchName: string,
  selectedRepositories: WorkspaceRepositoryInput[],
  arthurTaskId: string | null,
  agentKindOverride: AgentKind | null,
): Promise<{ sandboxId: string; agentKind: AgentKind }> {
  "use step";
  const { env } = await import("../../env.js");
  const { SandboxManager } = await import("../sandbox/manager.js");
  const { createAgentAdapter } = await import("../sandbox/agents/index.js");
  const { buildSandboxProviderConfigs } = await import("../lib/vcs-runtime.js");

  const arthur =
    env.GENAI_ENGINE_API_KEY && env.GENAI_ENGINE_TRACE_ENDPOINT && arthurTaskId
      ? {
          apiKey: env.GENAI_ENGINE_API_KEY,
          taskId: arthurTaskId,
          endpoint: env.GENAI_ENGINE_TRACE_ENDPOINT,
        }
      : undefined;

  const agentKind: AgentKind = agentKindOverride ?? env.AGENT_KIND;
  if (agentKind === "codex" && !env.CODEX_API_KEY && !env.CODEX_CHATGPT_OAUTH_TOKEN) {
    throw new Error(
      "agent override agent:codex requires CODEX_API_KEY or CODEX_CHATGPT_OAUTH_TOKEN in the deployed environment",
    );
  }
  if (agentKind === "claude" && !env.ANTHROPIC_API_KEY) {
    throw new Error(
      "agent override agent:claude requires ANTHROPIC_API_KEY in the deployed environment",
    );
  }
  const agent = createAgentAdapter(agentKind);

  const manager = new SandboxManager({
    providers: await buildSandboxProviderConfigs(
      selectedRepositories.map((repo) => repo.provider),
    ),
    jobTimeoutMs: env.JOB_TIMEOUT_MS,
  });

  const sandbox = await manager.provisionMultiRepo(
    { branchName, repositories: selectedRepositories },
    agent,
    {
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      codexApiKey: env.CODEX_API_KEY,
      codexChatGptOauthToken: env.CODEX_CHATGPT_OAUTH_TOKEN,
      model: agentKind === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL,
      arthur,
    },
  );

  return { sandboxId: sandbox.sandboxId, agentKind };
}
provisionSandbox.maxRetries = 0;

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

async function notifyTicket(ticketKey: string, event: TicketEvent) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { messaging } = createStepAdapters();
  await messaging.notifyForTicket(ticketKey, event);
}

async function logPhaseFailure(
  ticketKey: string,
  phase: "research" | "impl" | "review" | "pre-pr-checks" | "push",
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

async function registerTicketSandbox(ticketIdentifier: string, sandboxId: string) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { runRegistry } = createStepAdapters();
  await runRegistry.registerSandbox(ticketIdentifier, sandboxId);
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

export async function agentWorkflow(ticketId: string) {
  "use workflow";

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

  const ticket = await fetchAndValidateTicket(ticketId, env.COLUMN_AI);
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

  const { loadWorkflowDefinition } = await import("./definition-step.js");
  const plan = await loadWorkflowDefinition();

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
  // Set after provisionSandbox once agentKind is known.
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

    const preSandboxResult = await runPreSandboxPhaseStep({
      ticket: ticketData,
      run: {
        branchName,
      },
    });

    const preSandboxAdditions = preSandboxResult.promptAdditions ?? {};
    if (preSandboxResult.status === "halt") {
      await unregisterRun(ticket.identifier);

      if (preSandboxResult.outcome === "needs_clarification") {
        const questions = preSandboxResult.questions?.filter((q) => q.trim().length > 0) ?? [];
        const commentUrl = await postClarificationAndMoveBack(
          ticketId,
          questions.length > 0 ? questions : [preSandboxResult.message],
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
        reason: `pre-sandbox: ${preSandboxResult.message}`,
        usageReport: usageReportOrUndefined(),
      });
      return;
    }

    const selectedRepositories = preSandboxResult.selectedRepositories ?? [];
    if (selectedRepositories.length === 0) {
      await unregisterRun(ticket.identifier);
      const commentUrl = await postClarificationAndMoveBack(
        ticketId,
        ["Which repository should this ticket modify?"],
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

    const { prepareSelectedRepositoryBranches } = await import("./repository-prs.js");
    await prepareSelectedRepositoryBranches(ticket.identifier, branchName, selectedRepositories);

    const repositoryContexts = await fetchSelectedRepositoryPRContexts(selectedRepositories);
    const workspaceRepositories: WorkspaceRepositoryInput[] = repositoryContexts.map((context) => ({
      ...context.repository,
      ...(context.hasConflicts ? { mergeBase: context.repository.defaultBranch } : {}),
    }));

    // One Arthur task per run: first run = ticket identifier, re-runs = identifier.N
    const arthurTaskId = await ensureArthurTaskForTicket(ticket.identifier);

    // Per-ticket agent override via labels (e.g. `agent:codex`). Falls
    // back to env.AGENT_KIND when the ticket has no override or the labels
    // are ambiguous (multiple distinct kinds).
    const agentKindOverride = await resolveAgentKindOverride(ticket.labels);

    // Provision sandbox once for all phases
    const { sandboxId, agentKind } = await provisionSandbox(
      branchName,
      workspaceRepositories,
      arthurTaskId,
      agentKindOverride,
    );
    // Pin the sandboxId to this ticket so cleanup paths (reconcile,
    // cancelRun, webhook-cancel) can stop it by id instead of doing a
    // branch scan across every running sandbox.
    await registerTicketSandbox(ticket.identifier, sandboxId);

    const defaultModel = agentKind === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL;
    activeModel = defaultModel;
    const resolveModel = (params: OrderedBlock["params"]): string =>
      typeof params.model === "string" && params.model.trim() ? params.model.trim() : defaultModel;

    if (agentKind === "codex") {
      const distinctModels = new Set<string>([defaultModel]);
      for (const block of plan.blocks) {
        if (
          block.type === "planning_agent" ||
          block.type === "implementation_agent" ||
          block.type === "review_agent"
        ) {
          distinctModels.add(resolveModel(block.params));
        }
      }
      const priceMap = new Map<string, { input: number; cached_input: number; output: number }>();
      for (const model of distinctModels) {
        const price = await fetchCodexPriceStep(model);
        if (price) priceMap.set(model, price);
      }
      priceLookup = (model) => priceMap.get(model) ?? null;
    }

    try {
      await writeAttachments(sandboxId, downloadedAttachments);

      const ctx: {
        researchPlanMarkdown: string;
        publication: WorkspacePublicationResult | null;
        runUnregisteredBeforePr: boolean;
        implementationModel: string;
      } = {
        researchPlanMarkdown: "",
        publication: null,
        runUnregisteredBeforePr: false,
        implementationModel: defaultModel,
      };

      const clarificationExit = async (questions: string[]): Promise<"stop"> => {
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
        return "stop";
      };

      const failureExit = async (
        phase: "research" | "impl" | "review" | "pre-pr-checks" | "push",
        reason: string,
        usageReport: string | undefined = usageReportOrUndefined(),
      ): Promise<"stop"> => {
        await logPhaseFailure(ticket.identifier, phase, reason);
        // Unregister BEFORE moveTicket so the Jira webhook for this move
        // can't race ahead and fire a duplicate "canceled" notification
        // (the registry entry is what makes the webhook treat a finishing
        // run as a cancellable orphan). Same reasoning at every terminal
        // path below.
        await unregisterRun(ticket.identifier);
        await moveTicket(ticketId, backlogMoveTarget());
        await notifyTicket(ticket.identifier, {
          kind: "failed",
          phase,
          reason,
          usageReport,
        });
        return "stop";
      };

      const runBlock = async (block: OrderedBlock): Promise<"continue" | "stop"> => {
        switch (block.type) {
          case "planning_agent": {
            const model = resolveModel(block.params);
            phaseModels["Research"] = model;
            await setCommitGuardStep(sandboxId, agentKind, false);

            const { paths: researchPaths, script: researchScript } =
              await planPhaseStep(agentKind, "research", model, RESEARCH_SCHEMA);
            const researchInput = assembleResearchPlanContext({
              ticket: ticketData,
              prompt: prompts.research,
              branchName,
              attachments: downloadedAttachments,
              preSandboxAdditions: preSandboxAdditions.research,
              repositoryContexts,
            });

            await writeAndStartPhase(
              sandboxId,
              researchPaths.input, researchInput,
              researchPaths.wrapper, researchScript,
            );
            launchedPhases.add("Research");

            const researchDone = await pollUntilDone(sandboxId, researchPaths.sentinel, 20);
            if (!researchDone) {
              return failureExit("research", "phase timed out");
            }

            const { raw: researchRaw, structured: researchStructured } =
              await collectPhase(sandboxId, researchPaths);
            const { research, usage: researchUsage } =
              await parseResearchStep(agentKind, researchRaw, researchStructured);
            phaseUsages["Research"] = researchUsage;

            if (research.status === "clarification_needed") {
              const questions = research.body.split("\n").filter((l) => /^\d+\./.test(l.trim()));
              return clarificationExit(questions.length > 0 ? questions : [research.body]);
            }

            if (research.status === "failed") {
              const reason = research.body.slice(0, 200);
              return failureExit("research", reason);
            }

            ctx.researchPlanMarkdown = research.body;
            return "continue";
          }

          case "implementation_agent": {
            const model = resolveModel(block.params);
            phaseModels["Impl"] = model;
            ctx.implementationModel = model;
            await setCommitGuardStep(sandboxId, agentKind, true);

            const { paths: implPaths, script: implScript } =
              await planPhaseStep(agentKind, "impl", model, AGENT_SCHEMA);
            const implInput = assembleImplementationContext({
              ticket: ticketData,
              prompt: prompts.implement,
              researchPlanMarkdown: ctx.researchPlanMarkdown,
              attachments: downloadedAttachments,
              preSandboxAdditions: preSandboxAdditions.implementation,
              selectedRepositories: workspaceRepositories,
            });

            await writeAndStartPhase(
              sandboxId,
              implPaths.input, implInput,
              implPaths.wrapper, implScript,
            );
            launchedPhases.add("Impl");

            const implDone = await pollUntilDone(sandboxId, implPaths.sentinel, 35);
            let implOutput: AgentOutput;

            if (implDone) {
              const { raw: implRaw, structured: implStructured } = await collectPhase(sandboxId, implPaths);
              const { output, usage: implUsage } = await parseAgentOutputStep(agentKind, implRaw, implStructured);
              phaseUsages["Impl"] = implUsage;
              implOutput = output;
            } else {
              implOutput = { result: "failed", error: "Implementation phase timed out" };
            }

            if (implOutput.result === "clarification_needed") {
              return clarificationExit(implOutput.questions ?? []);
            }

            if (implOutput.result === "failed") {
              const reason = implOutput.error ?? "unknown";
              return failureExit("impl", reason);
            }

            return "continue";
          }

          case "review_agent": {
            // Commit guard stays enabled (review fixes its own findings).
            const model = resolveModel(block.params);
            phaseModels["Review"] = model;
            const { paths: reviewPaths, script: reviewScript } =
              await planPhaseStep(agentKind, "review", model, REVIEW_SCHEMA);
            const reviewInput = assembleReviewContext({
              ticket: ticketData,
              prompt: prompts.review,
              researchPlanMarkdown: ctx.researchPlanMarkdown,
              attachments: downloadedAttachments,
              preSandboxAdditions: preSandboxAdditions.review,
              selectedRepositories: workspaceRepositories,
            });

            await writeAndStartPhase(
              sandboxId,
              reviewPaths.input, reviewInput,
              reviewPaths.wrapper, reviewScript,
            );
            launchedPhases.add("Review");

            const reviewDone = await pollUntilDone(sandboxId, reviewPaths.sentinel, 15);
            let reviewOutput: ReviewOutput;

            if (reviewDone) {
              const { raw: reviewRaw, structured: reviewStructured } = await collectPhase(sandboxId, reviewPaths);
              const { output, usage: reviewUsage } = await parseReviewStep(agentKind, reviewRaw, reviewStructured);
              phaseUsages["Review"] = reviewUsage;
              reviewOutput = output;
            } else {
              reviewOutput = { result: "failed", feedback: "", issues: [], error: "Review phase timed out" };
            }

            if (reviewOutput.result === "failed") {
              const reason = reviewOutput.error ?? "unknown";
              return failureExit("review", reason);
            }

            return "continue";
          }

          case "run_pre_pr_checks": {
            const maxFixCycles =
              typeof block.params.maxFixCycles === "number" ? block.params.maxFixCycles : undefined;
            const prePrChecks = await runPrePrChecksStep(
              sandboxId,
              agentKind,
              ctx.implementationModel,
              maxFixCycles,
            );
            if (!prePrChecks.passed) {
              const reason = prePrChecks.summary.slice(0, 2_000);
              return failureExit("pre-pr-checks", reason);
            }
            return "continue";
          }

          case "open_pr": {
            ctx.runUnregisteredBeforePr = false;
            const publication = await publishWorkspaceChanges({
              sandboxId,
              ticketKey: ticket.identifier,
              branchName,
              repositories: workspaceRepositories,
              title: ticket.title,
              agentKind,
              model: ctx.implementationModel,
              beforeCreatePullRequests: async () => {
                // Push has landed — agent work is durable. Unregister BEFORE any
                // downstream step that can trigger a Jira webhook: opening a PR can
                // transition the linked issue (GitHub-for-Jira / Jira automation),
                // and our own moveTicket fires a webhook for the AI → AI Review move.
                // Either webhook, if it sees a still-registered run, will call
                // cancelRun and emit a spurious "canceled" notification on top of
                // "pr_ready". Clearing the registry here closes that window.
                if (!ctx.runUnregisteredBeforePr) {
                  await unregisterRun(ticket.identifier);
                  ctx.runUnregisteredBeforePr = true;
                }
              },
            });
            ctx.publication = publication;

            if (publication.status === "failed") {
              await logPhaseFailure(ticket.identifier, "push", publication.reason);
              if (!ctx.runUnregisteredBeforePr) {
                await unregisterRun(ticket.identifier);
              }
              if (publication.prs.length > 0) {
                await postPrLinksComment(
                  ticket.identifier,
                  publication.prs,
                  "Pull requests created before publication failed:",
                );
              }
              await moveTicket(ticketId, backlogMoveTarget());
              await notifyTicket(ticket.identifier, {
                kind: "failed",
                phase: "push",
                reason: publication.reason,
                usageReport: usageReportOrUndefined(),
              });
              return "stop";
            }

            if (publication.prs.some((pr) => pr.isNew)) {
              await postPrLinksComment(ticket.identifier, publication.prs);
            }

            const primaryPr = publication.prs[0]!;
            prForTelemetry = { url: primaryPr.url, number: primaryPr.id };
            return "continue";
          }

          case "send_slack_message": {
            const publication = ctx.publication;
            if (publication?.status === "published") {
              const primaryPr = publication.prs[0]!;
              const usageReport = formatUsageReport(phaseUsages, priceLookup, activeModel, phaseModels);
              const message =
                typeof block.params.message === "string" ? block.params.message.trim() : "";
              await notifyTicket(ticket.identifier, {
                kind: "pr_ready",
                pr: { url: primaryPr.url, number: primaryPr.id },
                usageReport,
                ...(message ? { extraText: message } : {}),
              });
            }
            return "continue";
          }

          case "update_ticket_status": {
            const target =
              block.params.target === "backlog" ? backlogMoveTarget() : aiReviewMoveTarget();
            await moveTicket(ticketId, target);
            return "continue";
          }

          default:
            return "continue";
        }
      };

      for (const block of plan.blocks) {
        const outcome = await runBlock(block);
        if (outcome === "stop") return;
      }
      runOutcome = "success";
    } finally {
      await teardownSandbox(sandboxId);
    }
  } catch (err) {
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
