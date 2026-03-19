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
import { createSandboxProvider } from "../sandbox/index.js";
import type { SandboxProvider } from "../sandbox/types.js";
import { assembleFixingFeedbackContext } from "../context.js";

const logger = createLogger();

async function createProvider(): Promise<SandboxProvider> {
  if (appEnv.SANDBOX_PROVIDER === "vercel") {
    return createSandboxProvider({
      provider: "vercel",
      vercel: { vcpus: appEnv.VERCEL_SANDBOX_VCPUS },
    });
  }
  return createSandboxProvider({
    provider: "docker",
    docker: { image: appEnv.DOCKER_IMAGE, memoryLimitMb: appEnv.SANDBOX_MEMORY_MB },
  });
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

// ── Workflow orchestrator ──────────────────────────────────────────

export async function reviewFixTicket(
  ticketId: string,
  source: "jira" | "linear",
  triggeredBy: string,
  runAttemptId: string,
) {
  "use workflow";

  const validation = await validateReviewFix(ticketId, runAttemptId);
  if (!validation) return;

  const { branchName, prNumber } = validation;
  const result = await executeFixSandbox(ticketId, branchName, prNumber);

  if (result.containerId) {
    await recordContainerId(runAttemptId, result.containerId);
  }

  if (result.status === "complete" && result.containerId) {
    await pushAndTeardown(result.containerId, branchName);
    await finalizeFixSuccess(ticketId, runAttemptId, triggeredBy);
    return;
  }

  if (result.containerId) {
    await teardownStep(result.containerId);
  }
  await finalizeFixFailure(ticketId, runAttemptId, result.error);
  throw new Error(`Agent failed for ${ticketId}: ${result.error}`);
}

// ── Steps ──────────────────────────────────────────────────────────

async function validateReviewFix(ticketId: string, runAttemptId: string) {
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

  await db
    .update(tickets)
    .set({ workflowState: "fixing_feedback", updatedAt: new Date() })
    .where(eq(tickets.externalId, ticketId));

  await db
    .update(runAttempts)
    .set({ status: "running", branchName: ticketRow.branchName })
    .where(eq(runAttempts.id, runAttemptId));

  logger.info({ ticketId, runAttemptId, type: "review_fix", branchName: ticketRow.branchName, prNumber: parseInt(ticketRow.prId, 10) }, "job_started");

  return {
    branchName: ticketRow.branchName,
    prNumber: parseInt(ticketRow.prId, 10),
  };
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

  const provider = await createProvider();
  const result = await provider.runSandbox({
    branchName,
    requirementsMd,
    githubToken: appEnv.GITHUB_TOKEN!,
    repoUrl: `${owner}/${repo}`,
    oauthToken: appEnv.CLAUDE_CODE_OAUTH_TOKEN,
    model: appEnv.CLAUDE_MODEL,
    timeoutMs: appEnv.JOB_TIMEOUT_MS,
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
  const provider = await createProvider();
  try {
    await provider.pushBranch(containerId, branchName);
  } finally {
    await provider.teardown(containerId);
  }
}

async function teardownStep(containerId: string) {
  "use step";
  const provider = await createProvider();
  await provider.teardown(containerId);
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
