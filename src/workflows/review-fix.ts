import { FatalError } from "workflow";
import { sleep } from "workflow";
import type { AgentOutput } from "../sandbox/agent-runner.js";
import type { TicketContent } from "../adapters/issue-tracker/types.js";
import type { PRComment, CheckRunResult } from "../adapters/vcs/types.js";

// --- Step Functions ---

async function fetchAndValidateTicket(ticketId: string, columnAi: string) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { issueTracker } = createStepAdapters();
  const ticket = await issueTracker.fetchTicket(ticketId);

  if (ticket.trackerStatus.toLowerCase() !== columnAi.toLowerCase()) {
    return null;
  }
  return ticket;
}

async function fetchPRContext(branchName: string, baseBranch: string) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { vcs } = createStepAdapters();
  const pr = await vcs.findPR(branchName);
  if (!pr) throw new FatalError(`No open PR found for branch ${branchName}`);

  const comments = await vcs.getPRComments(pr.id);
  const hasConflicts = await vcs.getPRConflictStatus(pr.id);
  const checkResults = await vcs.getCheckRunResults(pr.id);

  let baseSha: string | undefined;
  if (hasConflicts) {
    baseSha = await vcs.getBranchSha(baseBranch);
  }

  return { pr, comments, hasConflicts, baseSha, checkResults };
}

async function assembleReviewFixRequirements(
  ticket: TicketContent,
  prComments: PRComment[],
  hasConflicts: boolean,
  checkResults: CheckRunResult[],
) {
  "use step";
  const { assembleFixingFeedbackContext } =
    await import("../sandbox/context.js");
  const { getPrompt } = await import("../lib/prompts.js");

  const prompt = getPrompt("review-fix.md");
  return assembleFixingFeedbackContext({
    ticket: {
      identifier: ticket.identifier,
      title: ticket.title,
      description: ticket.description,
      acceptanceCriteria: ticket.acceptanceCriteria,
      comments: ticket.comments,
    },
    prompt,
    prComments,
    hasConflicts,
    checkResults,
  });
}

async function provisionAndStartFixingAgent(
  branchName: string,
  requirementsMd: string,
  mergeBase: string,
): Promise<string> {
  "use step";
  const { env } = await import("../../env.js");
  const { SandboxManager } = await import("../sandbox/manager.js");
  const { startAgentDetached } = await import("../sandbox/run-agent.js");

  const manager = new SandboxManager({
    githubToken: env.GITHUB_TOKEN,
    owner: env.GITHUB_OWNER,
    repo: env.GITHUB_REPO,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    claudeCodeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
    claudeModel: env.CLAUDE_MODEL,
    commitAuthor: env.COMMIT_AUTHOR,
    commitEmail: env.COMMIT_EMAIL,
    jobTimeoutMs: env.JOB_TIMEOUT_MS,
  });

  const sandbox = await manager.provision(
    branchName,
    requirementsMd,
    mergeBase,
  );
  await startAgentDetached(sandbox);
  return sandbox.sandboxId;
}
provisionAndStartFixingAgent.maxRetries = 0;

async function pushChanges(
  branchName: string,
  files: Array<{ path: string; content: string }>,
  mergeParentSha?: string,
) {
  "use step";
  if (files.length === 0) return;
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { vcs } = createStepAdapters();
  await vcs.push(
    branchName,
    files,
    mergeParentSha ? { mergeParentSha } : undefined,
  );
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
  const runId = (await runRegistry.getRunId(ticketIdentifier)) ?? "unknown";
  await runRegistry.markFailed(ticketIdentifier, {
    runId,
    error,
    failedAt: new Date().toISOString(),
  });
}

// --- Workflow ---

export async function reviewFixWorkflow(ticketId: string, branchName: string) {
  "use workflow";

  const { env } = await import("../../env.js");

  const ticket = await fetchAndValidateTicket(ticketId, env.COLUMN_AI);
  if (!ticket) return;

  try {
    await notifySlack(
      `Task ${ticket.identifier} started — fixing review feedback`,
    );

    const { comments, hasConflicts, checkResults } = await fetchPRContext(
      branchName,
      env.GITHUB_BASE_BRANCH,
    );

    const requirementsMd = await assembleReviewFixRequirements(
      ticket,
      comments,
      hasConflicts,
      checkResults,
    );

    // --- Detached execution with polling ---
    const {
      checkAgentDone,
      collectAgentOutput,
      pushFromSandbox,
      fixAndRetryPush,
      teardownSandbox,
    } = await import("../sandbox/poll-agent.js");

    const sandboxId = await provisionAndStartFixingAgent(
      branchName,
      requirementsMd,
      env.GITHUB_BASE_BRANCH,
    );

    // Poll until agent finishes — use iteration counter for deterministic WDK replay.
    const POLL_INTERVAL = "30s";
    const MAX_POLLS = Math.ceil((35 * 60) / 30); // ~70 iterations ≈ 35 min
    let pollCount = 0;
    let agentDone = false;

    try {
      while (!agentDone) {
        await sleep(POLL_INTERVAL);
        pollCount++;

        if (pollCount >= MAX_POLLS) break;

        const status = await checkAgentDone(sandboxId);
        if (status === true) {
          agentDone = true;
        } else if (status === "stopped") {
          break;
        }
      }

      let output: AgentOutput;

      if (agentDone) {
        ({ output } = await collectAgentOutput(sandboxId));
      } else {
        output = {
          result: "failed",
          error: "Agent timed out or sandbox stopped unexpectedly",
        };
      }

      if (output.result === "implemented") {
        let pushResult = await pushFromSandbox(sandboxId, branchName);

        if (!pushResult.pushed && pushResult.error) {
          pushResult = await fixAndRetryPush(
            sandboxId,
            branchName,
            pushResult.error,
          );
        }

        if (!pushResult.pushed) {
          await moveTicket(ticketId, env.COLUMN_BACKLOG);
          await notifySlack(
            `Task ${ticket.identifier} failed: push failed — ${pushResult.error ?? "unknown"}`,
          );
          await unregisterRun(ticket.identifier);
          return;
        }

        await moveTicket(ticketId, env.COLUMN_AI_REVIEW);
        await notifySlack(
          `Task ${ticket.identifier} fixes applied, ready for re-review`,
        );
        await unregisterRun(ticket.identifier);
        return;
      }

      await moveTicket(ticketId, env.COLUMN_BACKLOG);
      await notifySlack(
        `Task ${ticket.identifier} review-fix failed: ${output.error ?? "unknown error"}`,
      );
      await unregisterRun(ticket.identifier);
    } finally {
      await teardownSandbox(sandboxId);
    }
  } catch (err) {
    console.error(`Workflow failed for ${ticket.identifier}:`, err);
    const moved = await moveTicket(ticketId, env.COLUMN_BACKLOG)
      .then(() => true)
      .catch(() => false);
    await notifySlack(
      `Task ${ticket.identifier} failed: ${(err as Error).message ?? "unknown"}`,
    ).catch(() => {});
    if (moved) {
      await unregisterRun(ticket.identifier).catch(() => {});
    } else {
      await markTicketFailed(
        ticket.identifier,
        `Failed to move ticket to backlog: ${(err as Error).message ?? "unknown"}`,
      ).catch(() => {});
    }
    throw err;
  }
}
