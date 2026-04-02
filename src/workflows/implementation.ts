import { sleep } from "workflow";
import type { AgentOutput } from "../sandbox/agent-runner.js";
import type { TicketContent } from "../adapters/issue-tracker/types.js";

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

async function createFeatureBranch(branchName: string, baseBranch: string) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { vcs } = createStepAdapters();
  await vcs.createBranch(branchName, baseBranch);
}

async function assembleImplementationRequirements(ticket: TicketContent) {
  "use step";
  const { assembleImplementationContext } = await import("../sandbox/context.js");
  const { getPrompt } = await import("../lib/prompts.js");

  const prompt = getPrompt("implement.md");
  return assembleImplementationContext({
    ticket: {
      identifier: ticket.identifier,
      title: ticket.title,
      description: ticket.description,
      acceptanceCriteria: ticket.acceptanceCriteria,
      comments: ticket.comments,
    },
    prompt,
  });
}

async function provisionAndStartAgent(
  branchName: string,
  requirementsMd: string,
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

  const sandbox = await manager.provision(branchName, requirementsMd);
  await startAgentDetached(sandbox);
  return sandbox.sandboxId;
}
provisionAndStartAgent.maxRetries = 0;

async function createPullRequest(
  branchName: string,
  title: string,
  summary: string,
) {
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
  identifier: string,
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

// --- Workflow (durable orchestration — no I/O directly here) ---

export async function implementationWorkflow(ticketId: string) {
  "use workflow";

  const { env } = await import("../../env.js");

  const ticket = await fetchAndValidateTicket(ticketId, env.COLUMN_AI);
  if (!ticket) return;

  try {
    await notifySlack(`Task ${ticket.identifier} started — implementing`);

    const branchName = `blazebot/${ticket.identifier.toLowerCase()}`;
    await createFeatureBranch(branchName, env.GITHUB_BASE_BRANCH);

    const requirementsMd = await assembleImplementationRequirements(ticket);

    // --- Detached execution with polling ---
    const { checkAgentDone, collectAgentOutput, pushFromSandbox, fixAndRetryPush, teardownSandbox } =
      await import("../sandbox/poll-agent.js");

    const sandboxId = await provisionAndStartAgent(branchName, requirementsMd);

    // Poll until agent finishes — workflow truly suspends between polls.
    // Use an iteration counter (not Date.now()) for deterministic WDK replay.
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
        output = { result: "failed", error: "Agent timed out or sandbox stopped unexpectedly" };
      }

      if (output.result === "implemented") {
        let pushResult = await pushFromSandbox(sandboxId, branchName);

        if (!pushResult.pushed && pushResult.error) {
          pushResult = await fixAndRetryPush(sandboxId, branchName, pushResult.error);
        }

        if (!pushResult.pushed) {
          await moveTicket(ticketId, env.COLUMN_BACKLOG);
          await notifySlack(`Task ${ticket.identifier} failed: push failed — ${pushResult.error ?? "unknown"}`);
          await unregisterRun(ticket.identifier);
          return;
        }

        await createPullRequest(branchName, ticket.title, output.summary ?? "");
        await moveTicket(ticketId, env.COLUMN_AI_REVIEW);
        await notifySlack(`Task ${ticket.identifier} PR ready for review`);
        await unregisterRun(ticket.identifier);
        return;
      }

      if (output.result === "clarification_needed") {
        await postClarificationAndMoveBack(
          ticketId,
          output.questions ?? [],
          ticket.identifier,
          env.COLUMN_BACKLOG,
        );
        await notifySlack(`Task ${ticket.identifier} needs clarification`);
        await unregisterRun(ticket.identifier);
        return;
      }

      await moveTicket(ticketId, env.COLUMN_BACKLOG);
      await notifySlack(`Task ${ticket.identifier} failed: ${output.error ?? "unknown error"}`);
      await unregisterRun(ticket.identifier);
    } finally {
      await teardownSandbox(sandboxId);
    }
  } catch (err) {
    console.error(`Workflow failed for ${ticket.identifier}:`, err);
    const moved = await moveTicket(ticketId, env.COLUMN_BACKLOG).then(() => true).catch(() => false);
    await notifySlack(`Task ${ticket.identifier} failed: ${(err as Error).message ?? "unknown"}`).catch(() => {});
    // Only unregister if the ticket was moved out of AI column.
    // If moveTicket failed, leave the Redis entry so the cron doesn't
    // dispatch a duplicate — reconcile will clean it up once the ticket
    // is manually moved or the run becomes terminal.
    if (moved) {
      await unregisterRun(ticket.identifier).catch(() => {});
    }
    throw err;
  }
}
