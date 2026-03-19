// packages/app/src/workflows/review-fix.ts
import { FatalError } from "workflow";
import { eq } from "drizzle-orm";
import {
  env,
  db,
  tickets,
  runAttempts,
  createLogger,
} from "@blazebot/shared";
import { appEnv } from "../env.js";
import { createAdapters, readPromptFile } from "../lib/adapters.js";
import {
  runSandbox,
  pushBranchFromContainer,
  teardownContainer,
} from "../sandbox/manager.js";
import { assembleFixingFeedbackContext } from "../context.js";

const logger = createLogger();

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

// ── Workflow orchestrator ──────────────────────────────────────────

export async function reviewFixTicket(
  ticketId: string,
  source: "jira" | "linear",
  triggeredBy: string,
) {
  "use workflow";

  const validation = await validateReviewFix(ticketId);
  if (!validation) return; // stale or missing data

  const { branchName, prNumber, ticketRowId } = validation;
  const run = await createFixRun(ticketId, ticketRowId, branchName, prNumber);
  const result = await executeFixSandbox(ticketId, branchName, prNumber);

  if (result.containerId) {
    await recordContainerId(run.id, result.containerId);
  }

  if (result.status === "complete" && result.containerId) {
    await pushAndTeardown(result.containerId, branchName);
    await finalizeFixSuccess(ticketId, run.id, triggeredBy);
    return;
  }

  // Failed
  if (result.containerId) {
    await teardownStep(result.containerId);
  }
  await finalizeFixFailure(ticketId, run.id, result.error);
  throw new Error(`Agent failed for ${ticketId}: ${result.error}`);
}

// ── Steps ──────────────────────────────────────────────────────────

async function validateReviewFix(ticketId: string) {
  "use step";
  const { jira } = createAdapters();
  const ticket = await jira.fetchTicket(ticketId);

  const colAi = normalize(env.COLUMN_AI);
  if (normalize(ticket.trackerStatus) !== colAi) {
    logger.info({ ticketId, trackerStatus: ticket.trackerStatus }, "stale_job_skipped");
    return null;
  }

  const ticketRow = (
    await db.select().from(tickets).where(eq(tickets.externalId, ticketId))
  )[0]!;

  if (!ticketRow.prId || !ticketRow.branchName) {
    throw new FatalError(`review_fix requires prId and branchName for ${ticketId}`);
  }

  return {
    branchName: ticketRow.branchName,
    prNumber: parseInt(ticketRow.prId, 10),
    ticketRowId: ticketRow.id,
  };
}

async function createFixRun(
  ticketId: string,
  ticketRowId: string,
  branchName: string,
  prNumber: number,
) {
  "use step";
  await db
    .update(tickets)
    .set({ workflowState: "fixing_feedback", updatedAt: new Date() })
    .where(eq(tickets.externalId, ticketId));

  const [run] = await db
    .insert(runAttempts)
    .values({
      ticketId: ticketRowId,
      type: "review_fix",
      status: "running",
      branchName,
    })
    .returning();

  await db
    .update(tickets)
    .set({ currentRunId: run!.id, updatedAt: new Date() })
    .where(eq(tickets.externalId, ticketId));

  logger.info({ ticketId, runId: run!.id, type: "review_fix", branchName, prNumber }, "job_started");
  return run!;
}

async function executeFixSandbox(
  ticketId: string,
  branchName: string,
  prNumber: number,
) {
  "use step";
  const { jira, github } = createAdapters();
  const owner = appEnv.GITHUB_REPO_OWNER!;
  const repo = appEnv.GITHUB_REPO_NAME!;

  const ticket = await jira.fetchTicket(ticketId);
  const promptContent = await readPromptFile("review-fix.md");

  const [prComments, hasConflicts] = await Promise.all([
    github.getPRComments(owner, repo, prNumber),
    github.getPRConflictStatus(owner, repo, prNumber),
  ]);

  const requirementsMd = assembleFixingFeedbackContext(
    ticket,
    prComments,
    hasConflicts,
    promptContent,
  );

  const result = await runSandbox({
    image: appEnv.DOCKER_IMAGE,
    branchName,
    requirementsMd,
    githubToken: appEnv.GITHUB_TOKEN!,
    repoUrl: `${owner}/${repo}`,
    oauthToken: appEnv.CLAUDE_CODE_OAUTH_TOKEN,
    model: appEnv.CLAUDE_MODEL,
    timeoutMs: appEnv.JOB_TIMEOUT_MS,
    memoryLimitMb: appEnv.SANDBOX_MEMORY_MB,
    developerMode: appEnv.DEVELOPER_MODE,
  });

  logger.info(
    { ticketId, exitCode: result.exitCode, containerId: result.containerId },
    "agent_exited",
  );

  return result;
}

async function recordContainerId(runId: string, containerId: string) {
  "use step";
  await db
    .update(runAttempts)
    .set({ containerId })
    .where(eq(runAttempts.id, runId));
}

async function pushAndTeardown(containerId: string, branchName: string) {
  "use step";
  try {
    await pushBranchFromContainer(containerId, branchName);
  } finally {
    await teardownContainer(containerId);
  }
}

async function teardownStep(containerId: string) {
  "use step";
  await teardownContainer(containerId);
}

async function finalizeFixSuccess(
  ticketId: string,
  runId: string,
  triggeredBy: string,
) {
  "use step";
  const { jira, messaging } = createAdapters();
  const ticket = await jira.fetchTicket(ticketId);

  await db
    .update(tickets)
    .set({
      workflowState: "awaiting_review",
      currentRunId: null,
      updatedAt: new Date(),
    })
    .where(eq(tickets.externalId, ticketId));

  await db
    .update(runAttempts)
    .set({ status: "succeeded", finishedAt: new Date() })
    .where(eq(runAttempts.id, runId));

  await jira.moveTicket(ticketId, env.COLUMN_AI_REVIEW);
  await messaging.notify(
    triggeredBy,
    `Task ${ticket.identifier} fixes applied, ready for re-review`,
  );
}

async function finalizeFixFailure(ticketId: string, runId: string, error?: string) {
  "use step";
  await db
    .update(runAttempts)
    .set({ status: "failed", error, finishedAt: new Date() })
    .where(eq(runAttempts.id, runId));

  await db
    .update(tickets)
    .set({ workflowState: "failed", currentRunId: null, updatedAt: new Date() })
    .where(eq(tickets.externalId, ticketId));
}
