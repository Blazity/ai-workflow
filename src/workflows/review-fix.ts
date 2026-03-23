import { FatalError } from "workflow";
import type { AgentOutput } from "../sandbox/agent-runner.js";
import type { TicketContent } from "../adapters/issue-tracker/types.js";
import type { PRComment } from "../adapters/vcs/types.js";

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

async function fetchPRContext(branchName: string) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { vcs } = createStepAdapters();
  const pr = await vcs.findPR(branchName);
  if (!pr) throw new FatalError(`No open PR found for branch ${branchName}`);

  const comments = await vcs.getPRComments(pr.id);
  const hasConflicts = await vcs.getPRConflictStatus(pr.id);
  return { pr, comments, hasConflicts };
}

async function assembleReviewFixRequirements(
  ticket: TicketContent,
  prComments: PRComment[],
  hasConflicts: boolean,
) {
  "use step";
  const { assembleFixingFeedbackContext } = await import("../sandbox/context.js");
  const { env } = await import("../../env.js");

  const prompt = env.REVIEW_FIX_PROMPT ?? "";
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
  });
}

async function runFixingAgentInSandbox(
  branchName: string,
  requirementsMd: string,
): Promise<{ output: AgentOutput; files: Array<{ path: string; content: string }> }> {
  "use step";
  const { env } = await import("../../env.js");
  const { SandboxManager } = await import("../sandbox/manager.js");
  const { buildAgentCommand, parseAgentOutput } = await import(
    "../sandbox/agent-runner.js"
  );
  const manager = new SandboxManager({
    githubToken: env.GITHUB_TOKEN,
    owner: env.GITHUB_OWNER,
    repo: env.GITHUB_REPO,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    claudeModel: env.CLAUDE_MODEL,
    commitAuthor: env.COMMIT_AUTHOR,
    commitEmail: env.COMMIT_EMAIL,
    jobTimeoutMs: env.JOB_TIMEOUT_MS,
    vercelToken: env.VERCEL_TOKEN,
    vercelTeamId: env.VERCEL_TEAM_ID,
    vercelProjectId: env.VERCEL_PROJECT_ID,
  });

  const sandbox = await manager.provision(branchName, requirementsMd);

  try {
    const { cmd, args } = buildAgentCommand(env.CLAUDE_MODEL);
    const result = await sandbox.runCommand({ cmd, args, cwd: "/vercel/sandbox" });
    const stdout = await result.stdout();
    const stderr = await result.stderr();

    await manager.runEndHook(sandbox);
    const files = await manager.extractChanges(sandbox);

    const raw = stdout.trim() || stderr.trim();
    const output = parseAgentOutput(raw);
    return { output, files };
  } catch (err) {
    await manager.runEndHook(sandbox).catch(() => {});
    const files = await manager.extractChanges(sandbox).catch(() => []);
    throw Object.assign(err as Error, { files });
  } finally {
    await manager.teardown(sandbox);
  }
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

// --- Workflow ---

export async function reviewFixWorkflow(
  ticketId: string,
  branchName: string,
) {
  "use workflow";

  const { env } = await import("../../env.js");

  const ticket = await fetchAndValidateTicket(ticketId, env.COLUMN_AI);
  if (!ticket) return;

  const { pr, comments, hasConflicts } = await fetchPRContext(branchName);

  const requirementsMd = await assembleReviewFixRequirements(
    ticket,
    comments,
    hasConflicts,
  );

  const { output, files } = await runFixingAgentInSandbox(branchName, requirementsMd);

  await pushChanges(branchName, files);

  if (output.result === "implemented") {
    await moveTicket(ticketId, env.COLUMN_AI_REVIEW);
    await notifySlack(`Task ${ticket.identifier} fixes applied, ready for re-review`);
    await unregisterRun(ticket.identifier);
    return;
  }

  await unregisterRun(ticket.identifier);
  throw new Error(`Agent failed for ${ticketId}: ${output.error}`);
}
