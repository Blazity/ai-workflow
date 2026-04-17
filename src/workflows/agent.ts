import { sleep } from "workflow";
import type { AgentOutput } from "../sandbox/agent-runner.js";
import type { ReviewOutput } from "../sandbox/agent-runner.js";
import type { PRComment, CheckRunResult } from "../adapters/vcs/types.js";
import type { TicketAttachment } from "../adapters/issue-tracker/types.js";
import type { DownloadedAttachment } from "../sandbox/attachments.js";
import type { PhaseUsage } from "../sandbox/usage.js";

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

async function provisionSandbox(
  branchName: string,
  mergeBase?: string,
): Promise<string> {
  "use step";
  const { env, getVcsConfig } = await import("../../env.js");
  const { SandboxManager } = await import("../sandbox/manager.js");
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

  const manager = new SandboxManager({
    kind: vcs.kind,
    token: vcs.token,
    repoPath: vcs.repoPath,
    host: vcs.host,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    claudeCodeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
    claudeModel: env.CLAUDE_MODEL,
    commitAuthor: env.COMMIT_AUTHOR,
    commitEmail: env.COMMIT_EMAIL,
    jobTimeoutMs: env.JOB_TIMEOUT_MS,
  });

  const sandbox = await manager.provision(branchName, mergeBase);
  return sandbox.sandboxId;
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

async function configureStopHook(sandboxId: string, enabled: boolean): Promise<void> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../sandbox/credentials.js");
  const { configureStopHookInSandbox } = await import("../sandbox/manager.js");

  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  await configureStopHookInSandbox(sandbox, enabled);
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
  const { getPrompt } = await import("../lib/prompts.js");
  const { buildPhaseScript } = await import("../sandbox/wrapper-script.js");
  const { parseResearchStatus, parseAgentOutput, parseReviewOutput, REVIEW_SCHEMA, AGENT_SCHEMA } =
    await import("../sandbox/agent-runner.js");
  const { assembleResearchPlanContext, assembleImplementationContext, assembleReviewContext } =
    await import("../sandbox/context.js");
  const { collectPhaseOutput, pushFromSandbox, fixAndRetryPush, teardownSandbox } =
    await import("../sandbox/poll-agent.js");
  const { extractUsage, unwrapResearchText, formatUsageReport } =
    await import("../sandbox/usage.js");

  const ticket = await fetchAndValidateTicket(ticketId, env.COLUMN_AI);
  if (!ticket) return;

  const phaseUsages: Record<string, PhaseUsage | null> = {};
  const usageSuffix = () =>
    Object.keys(phaseUsages).length
      ? `\n${formatUsageReport(phaseUsages)}`
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

    // Provision sandbox once for all phases
    const sandboxId = await provisionSandbox(branchName, mergeBase);

    try {
      await writeAttachments(sandboxId, downloadedAttachments);

      // ========== PHASE 1: Research & Plan ==========
      await configureStopHook(sandboxId, false);

      const ticketData = {
        identifier: ticket.identifier,
        title: ticket.title,
        description: ticket.description,
        acceptanceCriteria: ticket.acceptanceCriteria,
        comments: ticket.comments,
      };

      const researchInput = assembleResearchPlanContext({
        ticket: ticketData,
        prompt: getPrompt("research-plan.md"),
        branchName,
        prComments: prContext?.prComments,
        checkResults: prContext?.checkResults,
        hasConflicts: prContext?.hasConflicts,
        attachments: downloadedAttachments,
      });

      const researchScript = buildPhaseScript({
        model: env.CLAUDE_MODEL,
        phase: "research",
        inputFile: "/tmp/research-requirements.md",
        outputFile: "/tmp/research-stdout.txt",
        stderrFile: "/tmp/research-stderr.txt",
        sentinelFile: "/tmp/research-done",
      });

      await writeAndStartPhase(
        sandboxId,
        "/tmp/research-requirements.md", researchInput,
        "/tmp/research-wrapper.sh", researchScript,
      );

      const researchDone = await pollUntilDone(sandboxId, "/tmp/research-done", 20);
      if (!researchDone) {
        await moveTicket(ticketId, env.COLUMN_BACKLOG);
        await notifySlack(`Task ${ticket.identifier} failed: research phase timed out${usageSuffix()}`);
        await unregisterRun(ticket.identifier);
        return;
      }

      const researchRaw = await collectPhaseOutput(sandboxId, "/tmp/research-stdout.txt", "/tmp/research-stderr.txt");
      phaseUsages["Research"] = extractUsage(researchRaw);
      const research = parseResearchStatus(unwrapResearchText(researchRaw));

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

      await configureStopHook(sandboxId, true);

      const implInput = assembleImplementationContext({
        ticket: ticketData,
        prompt: getPrompt("implement.md"),
        researchPlanMarkdown,
        attachments: downloadedAttachments,
      });

      const implScript = buildPhaseScript({
        model: env.CLAUDE_MODEL,
        phase: "impl",
        inputFile: "/tmp/impl-requirements.md",
        outputFile: "/tmp/impl-stdout.txt",
        stderrFile: "/tmp/impl-stderr.txt",
        sentinelFile: "/tmp/impl-done",
        jsonSchema: AGENT_SCHEMA,
      });

      await writeAndStartPhase(
        sandboxId,
        "/tmp/impl-requirements.md", implInput,
        "/tmp/impl-wrapper.sh", implScript,
      );

      const implDone = await pollUntilDone(sandboxId, "/tmp/impl-done", 35);
      let implOutput: AgentOutput;

      if (implDone) {
        const implRaw = await collectPhaseOutput(sandboxId, "/tmp/impl-stdout.txt", "/tmp/impl-stderr.txt");
        phaseUsages["Impl"] = extractUsage(implRaw);
        implOutput = parseAgentOutput(implRaw);
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
      await configureStopHook(sandboxId, true);

      const gitDiff = await captureGitDiff(sandboxId);

      const reviewInput = assembleReviewContext({
        ticket: ticketData,
        prompt: getPrompt("review.md"),
        researchPlanMarkdown,
        gitDiff,
        attachments: downloadedAttachments,
      });

      const reviewScript = buildPhaseScript({
        model: env.CLAUDE_MODEL,
        phase: "review",
        inputFile: "/tmp/review-requirements.md",
        outputFile: "/tmp/review-stdout.txt",
        stderrFile: "/tmp/review-stderr.txt",
        sentinelFile: "/tmp/review-done",
        jsonSchema: REVIEW_SCHEMA,
      });

      await writeAndStartPhase(
        sandboxId,
        "/tmp/review-requirements.md", reviewInput,
        "/tmp/review-wrapper.sh", reviewScript,
      );

      const reviewDone = await pollUntilDone(sandboxId, "/tmp/review-done", 15);
      let reviewOutput: ReviewOutput;

      if (reviewDone) {
        const reviewRaw = await collectPhaseOutput(sandboxId, "/tmp/review-stdout.txt", "/tmp/review-stderr.txt");
        phaseUsages["Review"] = extractUsage(reviewRaw);
        reviewOutput = parseReviewOutput(reviewRaw);
      } else {
        reviewOutput = { result: "failed", feedback: "", issues: [], error: "Review phase timed out" };
      }

      if (reviewOutput.result === "failed") {
        await moveTicket(ticketId, env.COLUMN_BACKLOG);
        await notifySlack(`Task ${ticket.identifier} failed: review — ${reviewOutput.error ?? "unknown"}${usageSuffix()}`);
        await unregisterRun(ticket.identifier);
        return;
      }

      // ========== POST-PHASES: Push & PR ==========
      let pushResult = await pushFromSandbox(sandboxId, branchName);
      if (!pushResult.pushed && pushResult.error) {
        pushResult = await fixAndRetryPush(sandboxId, branchName, pushResult.error);
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
      const usageReport = formatUsageReport(phaseUsages);
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
