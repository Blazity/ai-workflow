import { Worker, Job } from "bullmq";
import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRedisConnection } from "./redis.js";
import { env } from "./env.js";
import { db } from "./db.js";
import { tickets, runAttempts } from "./schema.js";
import { JiraClient } from "./adapters/jira-client.js";
import { GitHubClient } from "./adapters/github-client.js";
import { ConsoleMessagingAdapter } from "./adapters/console-messaging.js";
import { runSandbox, pushBranchFromContainer, teardownContainer } from "./sandbox/manager.js";
import { assembleImplementationContext, assembleFixingFeedbackContext } from "./context.js";
import { createLogger, createTicketLogger, createRunLogger } from "./logger.js";
import type { TicketJobData } from "./queue.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, "..", "prompts");

const logger = createLogger();

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function createAdapters() {
  const jira = new JiraClient(
    env.JIRA_BASE_URL!,
    env.JIRA_USER_EMAIL!,
    env.JIRA_API_TOKEN!,
  );
  const github = new GitHubClient(env.GITHUB_TOKEN!);
  const messaging = new ConsoleMessagingAdapter();
  return { jira, github, messaging };
}

export function createWorker(): Worker<TicketJobData> {
  return new Worker<TicketJobData>(
    "ticket",
    async (job: Job<TicketJobData>) => {
      if (!("type" in job.data) || !("source" in job.data)) {
        logger.warn({ jobData: job.data }, "job_format_unrecognized");
        return;
      }

      if (job.data.type === "implementation") {
        await handleImplementation(job.data);
      } else if (job.data.type === "review_fix") {
        await handleReviewFix(job.data);
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: env.MAX_CONCURRENT_AGENTS,
    },
  );
}

async function handleImplementation(data: Extract<TicketJobData, { type: "implementation" }>) {
  const { jira, github, messaging } = createAdapters();
  const owner = env.GITHUB_REPO_OWNER!;
  const repo = env.GITHUB_REPO_NAME!;
  const baseBranch = env.GITHUB_BASE_BRANCH;
  const branchName = `blazebot/${data.ticketId}`;

  const ticket = await jira.fetchTicket(data.ticketId);

  const colAi = normalize(env.COLUMN_AI);
  if (normalize(ticket.trackerStatus) !== colAi) {
    logger.info(
      { ticketId: data.ticketId, trackerStatus: ticket.trackerStatus },
      "stale_job_skipped",
    );
    return;
  }

  const promptPath = resolve(PROMPTS_DIR, "implement.md");
  const promptContent = await readFile(promptPath, "utf-8");

  await github.createBranch(owner, repo, branchName, baseBranch);

  await db.update(tickets)
    .set({ workflowState: "implementing", updatedAt: new Date() })
    .where(eq(tickets.externalId, data.ticketId));

  const ticketRow = (
    await db.select().from(tickets).where(eq(tickets.externalId, data.ticketId))
  )[0]!;

  const ticketLog = createTicketLogger(logger, ticketRow.id, data.ticketId);

  const [run] = await db.insert(runAttempts)
    .values({
      ticketId: ticketRow.id,
      type: "implementation",
      status: "running",
      branchName,
    })
    .returning();

  await db.update(tickets)
    .set({ currentRunId: run!.id, updatedAt: new Date() })
    .where(eq(tickets.externalId, data.ticketId));

  const runLog = createRunLogger(ticketLog, run!.id);
  runLog.info({ type: "implementation", branchName }, "job_started");

  ticketLog.info({ from: "queued", to: "implementing" }, "ticket_state_transition");

  const requirementsMd = assembleImplementationContext(ticket, promptContent);

  const startTime = Date.now();

  const result = await runSandbox({
    image: env.DOCKER_IMAGE,
    branchName,
    requirementsMd,
    githubToken: env.GITHUB_TOKEN!,
    repoUrl: `${owner}/${repo}`,
    oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
    model: env.CLAUDE_MODEL,
    timeoutMs: env.JOB_TIMEOUT_MS,
    memoryLimitMb: env.SANDBOX_MEMORY_MB,
  });

  const durationMs = Date.now() - startTime;
  runLog.info(
    { exitCode: result.exitCode, containerId: result.containerId, durationMs },
    "agent_exited",
  );

  if (result.containerId) {
    await db.update(runAttempts)
      .set({ containerId: result.containerId })
      .where(eq(runAttempts.id, run!.id));
  }

  // Orchestrator pushes the branch on success/clarification (spec 15.2),
  // then always tears down the container (spec 9.3).
  try {
    if (result.containerId && (result.status === "complete" || result.status === "clarification_needed")) {
      await pushBranchFromContainer(result.containerId, branchName);
    }
  } finally {
    if (result.containerId) {
      await teardownContainer(result.containerId);
    }
  }

  if (result.status === "complete") {
    let pr;
    try {
      pr = await github.createPR(
        owner, repo,
        `[${data.ticketId}] ${ticket.title}`,
        result.summary ?? "",
        branchName, baseBranch,
      );
    } catch (prErr: unknown) {
      const ghErr = prErr as { status?: number; message?: string; response?: { data?: unknown } };
      runLog.error({
        status: ghErr.status,
        message: ghErr.message,
        responseData: ghErr.response?.data,
        branchName,
      }, "pr_creation_failed");
      throw prErr;
    }

    runLog.info({ prNumber: pr.number, prUrl: pr.url }, "pr_created");

    await db.update(tickets)
      .set({
        workflowState: "awaiting_review",
        prId: String(pr.number),
        branchName,
        currentRunId: null,
        updatedAt: new Date(),
      })
      .where(eq(tickets.externalId, data.ticketId));

    await db.update(runAttempts)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(runAttempts.id, run!.id));

    ticketLog.info({ from: "implementing", to: "awaiting_review" }, "ticket_state_transition");

    await jira.moveTicket(data.ticketId, env.COLUMN_AI_REVIEW);
    await messaging.notify(
      data.triggeredBy,
      `Task ${ticket.identifier} PR ready for review: ${pr.url}`,
    );
    return;
  }

  if (result.status === "clarification_needed") {
    const questions = (result.questions ?? []).join("\n\n");
    await jira.postComment(data.ticketId, questions);

    runLog.info("clarification_requested");

    await db.update(tickets)
      .set({
        workflowState: "clarification_pending",
        branchName,
        currentRunId: null,
        updatedAt: new Date(),
      })
      .where(eq(tickets.externalId, data.ticketId));

    await db.update(runAttempts)
      .set({ status: "clarification_needed", finishedAt: new Date() })
      .where(eq(runAttempts.id, run!.id));

    ticketLog.info({ from: "implementing", to: "clarification_pending" }, "ticket_state_transition");

    await jira.moveTicket(data.ticketId, env.COLUMN_BACKLOG);
    await messaging.notify(
      data.triggeredBy,
      `Task ${ticket.identifier} needs clarification`,
    );
    return;
  }

  runLog.error({ error: result.error }, "agent_failed");

  await db.update(runAttempts)
    .set({ status: "failed", error: result.error, finishedAt: new Date() })
    .where(eq(runAttempts.id, run!.id));

  await db.update(tickets)
    .set({ workflowState: "failed", currentRunId: null, updatedAt: new Date() })
    .where(eq(tickets.externalId, data.ticketId));

  ticketLog.info({ from: "implementing", to: "failed" }, "ticket_state_transition");

  throw new Error(
    `Agent failed for ${data.ticketId}: ${result.error}`,
  );
}

async function handleReviewFix(data: Extract<TicketJobData, { type: "review_fix" }>) {
  const { jira, github, messaging } = createAdapters();
  const owner = env.GITHUB_REPO_OWNER!;
  const repo = env.GITHUB_REPO_NAME!;

  const ticket = await jira.fetchTicket(data.ticketId);

  const colAi = normalize(env.COLUMN_AI);
  if (normalize(ticket.trackerStatus) !== colAi) {
    logger.info(
      { ticketId: data.ticketId, trackerStatus: ticket.trackerStatus },
      "stale_job_skipped",
    );
    return;
  }

  const ticketRow = (
    await db.select().from(tickets).where(eq(tickets.externalId, data.ticketId))
  )[0]!;

  if (!ticketRow.prId || !ticketRow.branchName) {
    logger.error({ ticketId: data.ticketId }, "review_fix_missing_pr_or_branch");
    throw new Error(`review_fix requires prId and branchName for ${data.ticketId}`);
  }

  const prNumber = parseInt(ticketRow.prId, 10);
  const branchName = ticketRow.branchName;

  await db.update(tickets)
    .set({ workflowState: "fixing_feedback", updatedAt: new Date() })
    .where(eq(tickets.externalId, data.ticketId));

  const ticketLog = createTicketLogger(logger, ticketRow.id, data.ticketId);

  const [run] = await db.insert(runAttempts)
    .values({
      ticketId: ticketRow.id,
      type: "review_fix",
      status: "running",
      branchName,
    })
    .returning();

  await db.update(tickets)
    .set({ currentRunId: run!.id, updatedAt: new Date() })
    .where(eq(tickets.externalId, data.ticketId));

  const runLog = createRunLogger(ticketLog, run!.id);
  runLog.info({ type: "review_fix", branchName, prNumber }, "job_started");

  ticketLog.info({ from: "awaiting_review", to: "fixing_feedback" }, "ticket_state_transition");

  const promptPath = resolve(PROMPTS_DIR, "review-fix.md");
  const promptContent = await readFile(promptPath, "utf-8");

  const [prComments, hasConflicts] = await Promise.all([
    github.getPRComments(owner, repo, prNumber),
    github.getPRConflictStatus(owner, repo, prNumber),
  ]);

  const requirementsMd = assembleFixingFeedbackContext(
    ticket, prComments, hasConflicts, promptContent,
  );

  const startTime = Date.now();

  const result = await runSandbox({
    image: env.DOCKER_IMAGE,
    branchName,
    requirementsMd,
    githubToken: env.GITHUB_TOKEN!,
    repoUrl: `${owner}/${repo}`,
    oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
    model: env.CLAUDE_MODEL,
    timeoutMs: env.JOB_TIMEOUT_MS,
    memoryLimitMb: env.SANDBOX_MEMORY_MB,
  });

  const durationMs = Date.now() - startTime;
  runLog.info(
    { exitCode: result.exitCode, containerId: result.containerId, durationMs },
    "agent_exited",
  );

  if (result.containerId) {
    await db.update(runAttempts)
      .set({ containerId: result.containerId })
      .where(eq(runAttempts.id, run!.id));
  }

  try {
    if (result.containerId && result.status === "complete") {
      await pushBranchFromContainer(result.containerId, branchName);
    }
  } finally {
    if (result.containerId) {
      await teardownContainer(result.containerId);
    }
  }

  if (result.status === "complete") {
    runLog.info({ prNumber }, "review_fix_complete");

    await db.update(tickets)
      .set({
        workflowState: "awaiting_review",
        currentRunId: null,
        updatedAt: new Date(),
      })
      .where(eq(tickets.externalId, data.ticketId));

    await db.update(runAttempts)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(runAttempts.id, run!.id));

    ticketLog.info({ from: "fixing_feedback", to: "awaiting_review" }, "ticket_state_transition");

    await jira.moveTicket(data.ticketId, env.COLUMN_AI_REVIEW);
    await messaging.notify(
      data.triggeredBy,
      `Task ${ticket.identifier} fixes applied, ready for re-review`,
    );
    return;
  }

  runLog.error({ error: result.error }, "agent_failed");

  await db.update(runAttempts)
    .set({ status: "failed", error: result.error, finishedAt: new Date() })
    .where(eq(runAttempts.id, run!.id));

  await db.update(tickets)
    .set({ workflowState: "failed", currentRunId: null, updatedAt: new Date() })
    .where(eq(tickets.externalId, data.ticketId));

  ticketLog.info({ from: "fixing_feedback", to: "failed" }, "ticket_state_transition");

  throw new Error(
    `Agent failed for ${data.ticketId}: ${result.error}`,
  );
}
