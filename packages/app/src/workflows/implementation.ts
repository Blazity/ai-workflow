// packages/app/src/workflows/implementation.ts
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
import {
  assembleImplementationContext,
} from "../context.js";

const logger = createLogger();

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

// ── Workflow orchestrator ──────────────────────────────────────────

export async function implementTicket(
  ticketId: string,
  source: "jira" | "linear",
  triggeredBy: string,
  runAttemptId: string,
) {
  "use workflow";

  const ticket = await fetchAndValidateTicket(ticketId);
  if (!ticket) return;

  const branchName = `blazebot/${ticketId}`;

  await setupBranch(ticketId, branchName, runAttemptId);
  const result = await executeSandbox(ticketId, branchName, ticket);

  if (result.containerId) {
    await recordContainerId(runAttemptId, result.containerId);
  }

  if (result.status === "complete" && result.containerId) {
    const pushResult = await pushAndTeardown(result.containerId, branchName);
    if (!pushResult.pushed) {
      await finalizeFailure(ticketId, runAttemptId, `Branch push failed — agent may not have committed code. Output: ${pushResult.output}`);
      throw new Error(`Push failed for ${ticketId}: ${pushResult.output}`);
    }
    const pr = await createPullRequest(ticketId, ticket.title, branchName, result.summary ?? "");
    await finalizeSuccess(ticketId, runAttemptId, branchName, pr, triggeredBy, ticket.identifier);
    return;
  }

  if (result.status === "clarification_needed") {
    if (result.containerId) {
      await pushAndTeardown(result.containerId, branchName);
    }
    await finalizeClarification(ticketId, runAttemptId, branchName, result.questions ?? [], triggeredBy, ticket.identifier);
    return;
  }

  if (result.containerId) {
    await teardownStep(result.containerId);
  }
  await finalizeFailure(ticketId, runAttemptId, result.error);
  throw new Error(`Agent failed for ${ticketId}: ${result.error}`);
}

// ── Steps (each has full Node.js runtime access) ───────────────────

async function fetchAndValidateTicket(ticketId: string) {
  "use step";
  const { jira } = createAdapters();
  const ticket = await jira.fetchTicket(ticketId);
  const colAi = normalize(env.COLUMN_AI);
  if (normalize(ticket.trackerStatus) !== colAi) {
    logger.info(
      { ticketId, trackerStatus: ticket.trackerStatus },
      "stale_job_skipped",
    );
    return null;
  }
  return ticket;
}

async function setupBranch(ticketId: string, branchName: string, runAttemptId: string) {
  "use step";
  const { github } = createAdapters();
  const owner = appEnv.GITHUB_REPO_OWNER!;
  const repo = appEnv.GITHUB_REPO_NAME!;
  const baseBranch = appEnv.GITHUB_BASE_BRANCH;

  await github.createBranch(owner, repo, branchName, baseBranch);

  await db
    .update(tickets)
    .set({ workflowState: "implementing", updatedAt: new Date() })
    .where(eq(tickets.externalId, ticketId));

  logger.info({ ticketId, from: "queued", to: "implementing" }, "ticket_state_transition");

  await db
    .update(runAttempts)
    .set({ status: "running", branchName })
    .where(eq(runAttempts.id, runAttemptId));
}


async function executeSandbox(
  ticketId: string,
  branchName: string,
  ticket: { title: string; description?: string; comments?: Array<{ body: string }> },
) {
  "use step";
  const promptContent = await readPromptFile("implement.md");
  const requirementsMd = assembleImplementationContext(ticket, promptContent);

  const startTime = Date.now();

  const result = await runSandbox({
    image: appEnv.DOCKER_IMAGE,
    branchName,
    requirementsMd,
    githubToken: appEnv.GITHUB_TOKEN!,
    repoUrl: `${appEnv.GITHUB_REPO_OWNER}/${appEnv.GITHUB_REPO_NAME}`,
    oauthToken: appEnv.CLAUDE_CODE_OAUTH_TOKEN,
    model: appEnv.CLAUDE_MODEL,
    timeoutMs: appEnv.JOB_TIMEOUT_MS,
    memoryLimitMb: appEnv.SANDBOX_MEMORY_MB,
    developerMode: appEnv.DEVELOPER_MODE,
  });

  const durationMs = Date.now() - startTime;
  logger.info(
    { ticketId, exitCode: result.exitCode, containerId: result.containerId, durationMs },
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
    const result = await pushBranchFromContainer(containerId, branchName);
    return result;
  } finally {
    await teardownContainer(containerId);
  }
}

async function teardownStep(containerId: string) {
  "use step";
  await teardownContainer(containerId);
}

async function createPullRequest(
  ticketId: string,
  title: string,
  branchName: string,
  summary: string,
) {
  "use step";
  const { github } = createAdapters();
  const owner = appEnv.GITHUB_REPO_OWNER!;
  const repo = appEnv.GITHUB_REPO_NAME!;
  const baseBranch = appEnv.GITHUB_BASE_BRANCH;

  let pr;
  try {
    pr = await github.createPR(
      owner,
      repo,
      `[${ticketId}] ${title}`,
      summary,
      branchName,
      baseBranch,
    );
  } catch (prErr: unknown) {
    const ghErr = prErr as { status?: number; message?: string; response?: { data?: unknown } };
    logger.error(
      { status: ghErr.status, message: ghErr.message, responseData: ghErr.response?.data, branchName },
      "pr_creation_failed",
    );

    // No commits between branches — agent reported success but didn't commit anything
    const isNoCommits =
      ghErr.status === 422 &&
      JSON.stringify(ghErr.response?.data ?? "").includes("No commits between");
    if (isNoCommits) {
      const { FatalError } = await import("workflow");
      throw new FatalError(
        `No commits on branch ${branchName} — agent completed without committing code`,
      );
    }

    throw prErr;
  }

  logger.info({ ticketId, prNumber: pr.number, prUrl: pr.url }, "pr_created");
  return pr;
}

async function finalizeSuccess(
  ticketId: string,
  runId: string,
  branchName: string,
  pr: { number: number; url: string },
  triggeredBy: string,
  identifier: string,
) {
  "use step";
  const { jira, messaging } = createAdapters();

  await db
    .update(tickets)
    .set({
      workflowState: "awaiting_review",
      prId: String(pr.number),
      branchName,
      currentRunId: null,
      updatedAt: new Date(),
    })
    .where(eq(tickets.externalId, ticketId));

  await db
    .update(runAttempts)
    .set({ status: "succeeded", finishedAt: new Date() })
    .where(eq(runAttempts.id, runId));

  logger.info({ ticketId, from: "implementing", to: "awaiting_review" }, "ticket_state_transition");

  await jira.moveTicket(ticketId, env.COLUMN_AI_REVIEW);
  await messaging.notify(
    triggeredBy,
    `Task ${identifier} PR ready for review: ${pr.url}`,
  );
}

async function finalizeClarification(
  ticketId: string,
  runId: string,
  branchName: string,
  questions: string[],
  triggeredBy: string,
  identifier: string,
) {
  "use step";
  const { jira, messaging } = createAdapters();

  await jira.postComment(ticketId, questions.join("\n\n"));
  logger.info({ ticketId }, "clarification_requested");

  await db
    .update(tickets)
    .set({
      workflowState: "clarification_pending",
      branchName,
      currentRunId: null,
      updatedAt: new Date(),
    })
    .where(eq(tickets.externalId, ticketId));

  await db
    .update(runAttempts)
    .set({ status: "clarification_needed", finishedAt: new Date() })
    .where(eq(runAttempts.id, runId));

  logger.info({ ticketId, from: "implementing", to: "clarification_pending" }, "ticket_state_transition");

  await jira.moveTicket(ticketId, env.COLUMN_BACKLOG);
  await messaging.notify(triggeredBy, `Task ${identifier} needs clarification`);
}

async function finalizeFailure(ticketId: string, runId: string, error?: string) {
  "use step";
  logger.error({ ticketId, error }, "agent_failed");

  await db
    .update(runAttempts)
    .set({ status: "failed", error, finishedAt: new Date() })
    .where(eq(runAttempts.id, runId));

  await db
    .update(tickets)
    .set({ workflowState: "failed", currentRunId: null, updatedAt: new Date() })
    .where(eq(tickets.externalId, ticketId));

  logger.info({ ticketId, from: "implementing", to: "failed" }, "ticket_state_transition");
}
