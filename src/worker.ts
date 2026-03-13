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
import { runSandbox } from "./sandbox/manager.js";
import { assembleImplementationContext } from "./context.js";
import type { TicketJobData } from "./queue.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, "..", "prompts");

function createAdapters() {
  const jira = new JiraClient(
    env.JIRA_BASE_URL!,
    env.JIRA_USER_EMAIL!,
    env.JIRA_API_TOKEN!,
  );
  const github = new GitHubClient(env.GITHUB_TOKEN!);
  return { jira, github };
}

export function createWorker(): Worker<TicketJobData> {
  return new Worker<TicketJobData>(
    "ticket",
    async (job: Job<TicketJobData>) => {
      if (!("type" in job.data) || !("source" in job.data)) {
        console.warn("Skipping job with unrecognized format:", job.data);
        return;
      }

      if (job.data.type === "implementation") {
        await handleImplementation(job.data);
      } else if (job.data.type === "review_fix") {
        throw new Error(
          `review_fix handler not yet implemented for ${job.data.ticketId}`,
        );
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: env.MAX_CONCURRENT_AGENTS,
    },
  );
}

async function handleImplementation(data: Extract<TicketJobData, { type: "implementation" }>) {
  const { jira, github } = createAdapters();
  const owner = env.GITHUB_REPO_OWNER!;
  const repo = env.GITHUB_REPO_NAME!;
  const baseBranch = env.GITHUB_BASE_BRANCH;
  const branchName = `blazebot/${data.ticketId}`;

  const ticket = await jira.fetchTicket(data.ticketId);

  const promptPath = resolve(PROMPTS_DIR, "implement.md");
  const promptContent = await readFile(promptPath, "utf-8");

  await github.createBranch(owner, repo, branchName, baseBranch);

  await db.update(tickets)
    .set({ workflowState: "implementing", updatedAt: new Date() })
    .where(eq(tickets.externalId, data.ticketId));

  const [run] = await db.insert(runAttempts)
    .values({
      ticketId: (
        await db.select().from(tickets).where(eq(tickets.externalId, data.ticketId))
      )[0]!.id,
      type: "implementation",
      status: "running",
      branchName,
    })
    .returning();

  const requirementsMd = assembleImplementationContext(ticket, promptContent);

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
  if (result.status === "complete") {
    const pr = await github.createPR(
      owner, repo,
      `[${data.ticketId}] ${ticket.title}`,
      result.summary ?? "",
      branchName, baseBranch,
    );

    await db.update(tickets)
      .set({
        workflowState: "awaiting_review",
        prId: String(pr.number),
        branchName,
        updatedAt: new Date(),
      })
      .where(eq(tickets.externalId, data.ticketId));

    await db.update(runAttempts)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(runAttempts.id, run!.id));

    await jira.moveTicket(data.ticketId, env.COLUMN_AI_REVIEW);
    return;
  }

  if (result.status === "clarification_needed") {
    const questions = (result.questions ?? []).join("\n\n");
    await jira.postComment(data.ticketId, questions);

    await db.update(tickets)
      .set({
        workflowState: "clarification_pending",
        branchName,
        updatedAt: new Date(),
      })
      .where(eq(tickets.externalId, data.ticketId));

    await db.update(runAttempts)
      .set({ status: "clarification_needed", finishedAt: new Date() })
      .where(eq(runAttempts.id, run!.id));

    await jira.moveTicket(data.ticketId, env.COLUMN_BACKLOG);
    return;
  }

  await db.update(runAttempts)
    .set({ status: "failed", error: result.error, finishedAt: new Date() })
    .where(eq(runAttempts.id, run!.id));

  await db.update(tickets)
    .set({ workflowState: "failed", updatedAt: new Date() })
    .where(eq(tickets.externalId, data.ticketId));

  throw new Error(
    `Agent failed for ${data.ticketId}: ${result.error}`,
  );
}
