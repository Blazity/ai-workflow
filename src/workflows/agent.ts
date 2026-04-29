import { sleep } from "workflow";
import type {
  AgentOutput, ReviewOutput, PhaseUsage, PhaseKind, PhaseArtifactPaths, ResearchResult,
} from "../sandbox/agents/types.js";
import type { AgentKind } from "../sandbox/agents/index.js";
import type { PRComment, CheckRunResult } from "../adapters/vcs/types.js";
import type { TicketAttachment } from "../adapters/issue-tracker/types.js";
import type { DownloadedAttachment } from "../sandbox/attachments.js";

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

async function createFeatureBranch(branchName: string, baseBranch: string) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { vcs } = createStepAdapters();
  await vcs.createBranch(branchName, baseBranch);
}

async function fetchPRContext(branchName: string): Promise<{
  prComments: PRComment[];
  checkResults: CheckRunResult[];
  hasConflicts: boolean;
} | null> {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { vcs } = createStepAdapters();
  const pr = await vcs.findPR(branchName);
  if (!pr) return null;

  const prComments = await vcs.getPRComments(pr.id);
  const hasConflicts = await vcs.getPRConflictStatus(pr.id);
  const checkResults = await vcs.getCheckRunResults(pr.id);
  return { prComments, hasConflicts, checkResults };
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
  arthurTaskId: string | null,
  agentKindOverride: AgentKind | null,
  mergeBase?: string,
): Promise<{ sandboxId: string; agentKind: AgentKind }> {
  "use step";
  const { env, getVcsConfig } = await import("../../env.js");
  const { SandboxManager } = await import("../sandbox/manager.js");
  const { createAgentAdapter } = await import("../sandbox/agents/index.js");
  const vcs = getVcsConfig();

  // The sandbox builds clone/push URLs by interpolating repoPath into a URL,
  // so it must be a URL-safe namespace/project path (e.g. "group/repo").
  // GitLab also accepts numeric project IDs in its REST API, but those produce
  // invalid clone URLs like "https://gitlab.com/12345.git". Fail fast with a
  // clear message rather than producing a confusing git clone error.
  if (vcs.kind === "gitlab" && /^\d+$/.test(vcs.repoPath)) {
    throw new Error(
      `GITLAB_PROJECT_ID must be a namespace/project path (e.g. "group/repo"), ` +
        `not a numeric project ID ("${vcs.repoPath}"). Numeric IDs work for the ` +
        `GitLab REST API but cannot be used to construct a git clone URL.`,
    );
  }

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
  if (agentKind === "claude" && !env.ANTHROPIC_API_KEY && !env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error(
      "agent override agent:claude requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in the deployed environment",
    );
  }
  const agent = createAgentAdapter(agentKind);

  const manager = new SandboxManager({
    kind: vcs.kind,
    token: vcs.token,
    repoPath: vcs.repoPath,
    host: vcs.host,
    jobTimeoutMs: env.JOB_TIMEOUT_MS,
    commitAuthor: env.COMMIT_AUTHOR,
    commitEmail: env.COMMIT_EMAIL,
  });

  const sandbox = await manager.provision(branchName, agent, {
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    claudeCodeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
    codexApiKey: env.CODEX_API_KEY,
    codexChatGptOauthToken: env.CODEX_CHATGPT_OAUTH_TOKEN,
    model: agentKind === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL,
    arthur,
  }, mergeBase);

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

async function captureGitDiff(sandboxId: string): Promise<string> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../sandbox/credentials.js");

  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const baseShaResult = await sandbox.runCommand("bash", [
    "-c", "cat /tmp/.pre-agent-sha 2>/dev/null || echo ''",
  ]);
  const baseSha = (await baseShaResult.stdout()).trim();

  const diffCmd = baseSha
    ? `git diff ${baseSha}..HEAD`
    : "git diff HEAD";
  const diffResult = await sandbox.runCommand("bash", ["-c", diffCmd]);
  return (await diffResult.stdout()).trim();
}

async function createPullRequest(branchName: string, title: string, summary: string) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { vcs } = createStepAdapters();
  return vcs.createPR(branchName, title, summary);
}

async function moveTicket(ticketId: string, column: string) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { issueTracker } = createStepAdapters();
  await issueTracker.moveTicket(ticketId, column);
}

async function notifySlack(message: string) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { messaging } = createStepAdapters();
  await messaging.notify(message);
}

async function postClarificationAndMoveBack(
  ticketId: string,
  questions: string[],
  backlogColumn: string,
) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { issueTracker } = createStepAdapters();
  const comment = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  await issueTracker.postComment(ticketId, comment);
  await issueTracker.moveTicket(ticketId, backlogColumn);
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

  const { env, getVcsConfig } = await import("../../env.js");
  const { assembleResearchPlanContext, assembleImplementationContext } =
    await import("../sandbox/context.js");
  const { collectPhase, pushFromSandbox, fixAndRetryPush, teardownSandbox } =
    await import("../sandbox/poll-agent.js");
  const { formatUsageReport } = await import("../sandbox/usage.js");
  const { AGENT_SCHEMA } = await import("../sandbox/agents/types.js");

  const ticket = await fetchAndValidateTicket(ticketId, env.COLUMN_AI);
  if (!ticket) return;

  const { loadPrompts } = await import("./prompts-step.js");
  const prompts = await loadPrompts();

  const phaseUsages: Record<string, PhaseUsage | null> = {};
  // Set after provisionSandbox once agentKind is known.
  let activeModel: string | undefined;
  let priceLookup: ((m: string) => { input: number; cached_input: number; output: number } | null) | undefined;
  const usageSuffix = () =>
    Object.keys(phaseUsages).length
      ? `\n${formatUsageReport(phaseUsages, priceLookup, activeModel)}`
      : "";

  try {
    await notifySlack(`Task ${ticket.identifier} started`);

    const branchName = `blazebot/${ticket.identifier.toLowerCase()}`;

    // Check for existing PR BEFORE creating/resetting the branch.
    // createFeatureBranch force-resets the branch to main's HEAD, which causes
    // GitHub to auto-close any open PR (no diff = no PR).
    const prContext = await fetchPRContext(branchName);

    const baseBranch = getVcsConfig().baseBranch;

    if (!prContext) {
      // New ticket — create (or reset) the branch from base
      await createFeatureBranch(branchName, baseBranch);
    }
    // Review-fix: branch + PR already exist, keep the branch as-is

    const mergeBase = prContext?.hasConflicts ? baseBranch : undefined;

    const downloadedAttachments = await fetchAttachments(ticket.identifier, ticket.attachments);

    // One Arthur task per run: first run = ticket identifier, re-runs = identifier.N
    const arthurTaskId = await ensureArthurTaskForTicket(ticket.identifier);

    // Per-ticket agent override via labels (e.g. `agent:codex`). Falls
    // back to env.AGENT_KIND when the ticket has no override or the labels
    // are ambiguous (multiple distinct kinds).
    const agentKindOverride = await resolveAgentKindOverride(ticket.labels);

    // Provision sandbox once for all phases
    const { sandboxId, agentKind } = await provisionSandbox(branchName, arthurTaskId, agentKindOverride, mergeBase);
    // Pin the sandboxId to this ticket so cleanup paths (reconcile,
    // cancelRun, webhook-cancel) can stop it by id instead of doing a
    // branch scan across every running sandbox.
    await registerTicketSandbox(ticket.identifier, sandboxId);

    activeModel = agentKind === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL;
    if (agentKind === "codex") {
      const priceCache = await fetchCodexPriceStep(activeModel);
      if (priceCache) priceLookup = () => priceCache;
    }

    try {
      await writeAttachments(sandboxId, downloadedAttachments);

      // ========== PHASE 1: Research & Plan ==========
      await setCommitGuardStep(sandboxId, agentKind, false);

      const ticketData = {
        identifier: ticket.identifier,
        title: ticket.title,
        description: ticket.description,
        acceptanceCriteria: ticket.acceptanceCriteria,
        comments: ticket.comments,
      };

      const { paths: researchPaths, script: researchScript } =
        await planPhaseStep(agentKind, "research", activeModel);
      const researchInput = assembleResearchPlanContext({
        ticket: ticketData,
        prompt: prompts.research,
        branchName,
        prComments: prContext?.prComments,
        checkResults: prContext?.checkResults,
        hasConflicts: prContext?.hasConflicts,
        attachments: downloadedAttachments,
      });

      await writeAndStartPhase(
        sandboxId,
        researchPaths.input, researchInput,
        researchPaths.wrapper, researchScript,
      );

      const researchDone = await pollUntilDone(sandboxId, researchPaths.sentinel, 20);
      if (!researchDone) {
        await moveTicket(ticketId, env.COLUMN_BACKLOG);
        await notifySlack(`Task ${ticket.identifier} failed: research phase timed out${usageSuffix()}`);
        await unregisterRun(ticket.identifier);
        return;
      }

      const { raw: researchRaw, structured: researchStructured } =
        await collectPhase(sandboxId, researchPaths);
      const { research, usage: researchUsage } =
        await parseResearchStep(agentKind, researchRaw, researchStructured);
      phaseUsages["Research"] = researchUsage;

      if (research.status === "clarification_needed") {
        const questions = research.body.split("\n").filter((l) => /^\d+\./.test(l.trim()));
        await postClarificationAndMoveBack(
          ticketId,
          questions.length > 0 ? questions : [research.body],
          env.COLUMN_BACKLOG,
        );
        await notifySlack(`Task ${ticket.identifier} needs clarification${usageSuffix()}`);
        await unregisterRun(ticket.identifier);
        return;
      }

      if (research.status === "failed") {
        await moveTicket(ticketId, env.COLUMN_BACKLOG);
        await notifySlack(`Task ${ticket.identifier} failed: research — ${research.body.slice(0, 200)}${usageSuffix()}`);
        await unregisterRun(ticket.identifier);
        return;
      }

      const researchPlanMarkdown = research.body;

      // ========== PHASE 2: Implementation ==========

      await setCommitGuardStep(sandboxId, agentKind, true);

      const { paths: implPaths, script: implScript } =
        await planPhaseStep(agentKind, "impl", activeModel, AGENT_SCHEMA);
      const implInput = assembleImplementationContext({
        ticket: ticketData,
        prompt: prompts.implement,
        researchPlanMarkdown,
        attachments: downloadedAttachments,
      });

      await writeAndStartPhase(
        sandboxId,
        implPaths.input, implInput,
        implPaths.wrapper, implScript,
      );

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
        await postClarificationAndMoveBack(
          ticketId,
          implOutput.questions ?? [],
          env.COLUMN_BACKLOG,
        );
        await notifySlack(`Task ${ticket.identifier} needs clarification${usageSuffix()}`);
        await unregisterRun(ticket.identifier);
        return;
      }

      if (implOutput.result === "failed") {
        await moveTicket(ticketId, env.COLUMN_BACKLOG);
        await notifySlack(`Task ${ticket.identifier} failed: implementation — ${implOutput.error ?? "unknown"}${usageSuffix()}`);
        await unregisterRun(ticket.identifier);
        return;
      }

      // ========== PHASE 3: Review ==========
      // Temporarily disabled.
      // await setCommitGuardStep(sandboxId, agentKind, true);
      //
      // const gitDiff = await captureGitDiff(sandboxId);
      //
      // const reviewPaths = agent.artifactPaths("review");
      // const reviewInput = assembleReviewContext({
      //   ticket: ticketData,
      //   prompt: prompts.review,
      //   researchPlanMarkdown,
      //   gitDiff,
      //   attachments: downloadedAttachments,
      // });
      //
      // const reviewScript = agent.buildPhaseScript({
      //   phase: "review",
      //   model: activeModel,
      //   paths: reviewPaths,
      //   jsonSchema: REVIEW_SCHEMA,
      // });
      //
      // await writeAndStartPhase(
      //   sandboxId,
      //   reviewPaths.input, reviewInput,
      //   reviewPaths.wrapper, reviewScript,
      // );
      //
      // const reviewDone = await pollUntilDone(sandboxId, reviewPaths.sentinel, 15);
      // let reviewOutput: ReviewOutput;
      //
      // if (reviewDone) {
      //   const { raw: reviewRaw, structured: reviewStructured } = await collectPhase(sandboxId, reviewPaths);
      //   phaseUsages["Review"] = agent.extractUsage(reviewRaw, reviewStructured);
      //   reviewOutput = agent.parseReviewOutput(reviewRaw, reviewStructured);
      // } else {
      //   reviewOutput = { result: "failed", feedback: "", issues: [], error: "Review phase timed out" };
      // }
      //
      // if (reviewOutput.result === "failed") {
      //   await moveTicket(ticketId, env.COLUMN_BACKLOG);
      //   await notifySlack(`Task ${ticket.identifier} failed: review — ${reviewOutput.error ?? "unknown"}${usageSuffix()}`);
      //   await unregisterRun(ticket.identifier);
      //   return;
      // }

      // ========== POST-PHASES: Push & PR ==========
      let pushResult = await pushFromSandbox(sandboxId, branchName);
      if (!pushResult.pushed && pushResult.error) {
        pushResult = await fixAndRetryPush(sandboxId, branchName, pushResult.error, agentKind, activeModel);
      }

      if (!pushResult.pushed) {
        await moveTicket(ticketId, env.COLUMN_BACKLOG);
        await notifySlack(`Task ${ticket.identifier} failed: push failed — ${pushResult.error ?? "unknown"}${usageSuffix()}`);
        await unregisterRun(ticket.identifier);
        return;
      }

      if (!prContext) {
        await createPullRequest(branchName, ticket.title, "");
      }
      // Notify Slack BEFORE moving the ticket out of the AI column.
      // Reconcile cancels runs whose tickets have left AI column; racing
      // that cancellation after moveTicket would skip the notification.
      const usageReport = formatUsageReport(phaseUsages, priceLookup, activeModel);
      await notifySlack(`Task ${ticket.identifier} PR ready for review\n${usageReport}`);
      await moveTicket(ticketId, env.COLUMN_AI_REVIEW);
      await unregisterRun(ticket.identifier);
    } finally {
      await teardownSandbox(sandboxId);
    }
  } catch (err) {
    console.error(`Workflow failed for ${ticket.identifier}:`, err);
    const moved = await moveTicket(ticketId, env.COLUMN_BACKLOG).then(() => true).catch(() => false);
    await notifySlack(`Task ${ticket.identifier} failed: ${(err as Error).message ?? "unknown"}${usageSuffix()}`).catch(() => {});
    if (moved) {
      await unregisterRun(ticket.identifier).catch(() => {});
    } else {
      await markTicketFailed(ticket.identifier, `Failed to move ticket to backlog: ${(err as Error).message ?? "unknown"}`).catch(() => {});
    }
    throw err;
  }
}
