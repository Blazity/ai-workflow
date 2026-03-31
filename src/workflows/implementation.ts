import { sleep } from "workflow";
import type { AgentOutput } from "../sandbox/agent-runner.js";
import type { AgentStatus } from "../sandbox/run-agent.js";
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
): Promise<{ sandboxId: string; cmdId: string }> {
  "use step";
  const { env } = await import("../../env.js");
  const { SandboxManager } = await import("../sandbox/manager.js");
  const { startAgent } = await import("../sandbox/run-agent.js");

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
    vercelToken: env.VERCEL_TOKEN,
    vercelTeamId: env.VERCEL_TEAM_ID,
    vercelProjectId: env.VERCEL_PROJECT_ID,
  });

  // No mergeBase needed — the branch was just created from GITHUB_BASE_BRANCH,
  // so it's already at the tip. Only review-fix passes mergeBase to handle drift.
  const sandbox = await manager.provision(branchName, requirementsMd);
  return startAgent({ sandbox, model: env.CLAUDE_MODEL, debug: env.DEBUG_AGENT });
}

async function pollAgentStatus(
  sandboxId: string,
  cmdId: string,
): Promise<AgentStatus> {
  "use step";
  const { env } = await import("../../env.js");
  const { SandboxManager } = await import("../sandbox/manager.js");
  const { checkAgentStatus } = await import("../sandbox/run-agent.js");

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
    vercelToken: env.VERCEL_TOKEN,
    vercelTeamId: env.VERCEL_TEAM_ID,
    vercelProjectId: env.VERCEL_PROJECT_ID,
  });

  return checkAgentStatus({ sandboxId, cmdId, manager });
}

async function waitAndCollectResults(
  sandboxId: string,
  cmdId: string,
): Promise<{ output: AgentOutput; files: Array<{ path: string; content: string }> }> {
  "use step";
  const { env } = await import("../../env.js");
  const { SandboxManager } = await import("../sandbox/manager.js");
  const { collectAgentResults } = await import("../sandbox/run-agent.js");

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
    vercelToken: env.VERCEL_TOKEN,
    vercelTeamId: env.VERCEL_TEAM_ID,
    vercelProjectId: env.VERCEL_PROJECT_ID,
  });

  return collectAgentResults({
    sandboxId,
    cmdId,
    manager,
    debug: env.DEBUG_AGENT,
  });
}

async function pushChanges(
  branchName: string,
  files: Array<{ path: string; content: string }>,
) {
  "use step";
  if (files.length === 0) return;
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { vcs } = createStepAdapters();
  await vcs.push(branchName, files);
}

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

function formatStats(output: AgentOutput): string {
  const parts: string[] = [];
  if (output.numTurns != null) parts.push(`${output.numTurns} turns`);
  if (output.costUsd != null) parts.push(`$${output.costUsd.toFixed(2)}`);
  return parts.length ? ` (${parts.join(", ")})` : "";
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
    const { sandboxId, cmdId } = await provisionAndStartAgent(branchName, requirementsMd);

    // Poll with sleep — workflow suspends between checks, no compute wasted.
    let status = await pollAgentStatus(sandboxId, cmdId);
    while (status === "running") {
      await sleep("30s");
      status = await pollAgentStatus(sandboxId, cmdId);
    }

    if (status === "gone") {
      await moveTicket(ticketId, env.COLUMN_BACKLOG);
      await notifySlack(`Task ${ticket.identifier} failed: sandbox expired before agent finished`);
      await unregisterRun(ticket.identifier);
      return;
    }

    const { output, files } = await waitAndCollectResults(sandboxId, cmdId);

    await pushChanges(branchName, files);

    const stats = formatStats(output);

    if (output.result === "implemented") {
      await createPullRequest(branchName, ticket.title, output.summary ?? "");
      await moveTicket(ticketId, env.COLUMN_AI_REVIEW);
      await notifySlack(`Task ${ticket.identifier} PR ready for review${stats}`);
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
      await notifySlack(`Task ${ticket.identifier} needs clarification${stats}`);
      await unregisterRun(ticket.identifier);
      return;
    }

    await moveTicket(ticketId, env.COLUMN_BACKLOG);
    await notifySlack(`Task ${ticket.identifier} failed: ${output.error ?? "unknown error"}${stats}`);
    await unregisterRun(ticket.identifier);
  } catch (err) {
    console.error(`Workflow failed for ${ticket.identifier}:`, err);
    await moveTicket(ticketId, env.COLUMN_BACKLOG).catch(() => {});
    await notifySlack(`Task ${ticket.identifier} failed: ${(err as Error).message ?? "unknown"}`).catch(() => {});
    await unregisterRun(ticket.identifier).catch(() => {});
    throw err;
  }
}
