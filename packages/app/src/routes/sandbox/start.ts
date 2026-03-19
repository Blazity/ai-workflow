import { defineEventHandler, createError } from "nitro/h3";
import { Sandbox } from "@vercel/sandbox";
import { createLogger } from "@blazebot/shared";

const logger = createLogger();

/** Environment variables to forward into the sandbox. */
const ENV_KEYS = [
  "DATABASE_URL",
  "WORKFLOW_POSTGRES_URL",
  "WORKFLOW_TARGET_WORLD",
  "NODE_ENV",
  "COLUMN_AI",
  "COLUMN_AI_REVIEW",
  "COLUMN_BACKLOG",
  "ISSUE_TRACKER_KIND",
  "VCS_KIND",
  "MESSAGING_KIND",
  "SLACK_BOT_TOKEN",
  "SLACK_DEFAULT_CHANNEL",
  "JIRA_BASE_URL",
  "JIRA_USER_EMAIL",
  "JIRA_API_TOKEN",
  "JIRA_PROJECT_KEY",
  "JIRA_WEBHOOK_SECRET",
  "GITHUB_TOKEN",
  "GITHUB_REPO_OWNER",
  "GITHUB_REPO_NAME",
  "GITHUB_BASE_BRANCH",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_MODEL",
  "DEVELOPER_MODE",
  "SANDBOX_PROVIDER",
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
  "VERCEL_SANDBOX_VCPUS",
  "JOB_TIMEOUT_MS",
  "POLL_INTERVAL_MS",
  "MAX_CONCURRENT_AGENTS",
  "STUCK_JOB_THRESHOLD_MS",
  "PORT",
] as const;

function buildSandboxEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const val = process.env[key];
    if (val) env[key] = val;
  }
  return env;
}

async function findRunningSandbox(): Promise<string | null> {
  const { json: { sandboxes } } = await Sandbox.list();
  const running = sandboxes.find(
    (s: { status: string }) => s.status === "running",
  );
  return running?.id ?? null;
}

export default defineEventHandler(async () => {
  const existing = await findRunningSandbox();
  if (existing) {
    logger.info({ sandboxId: existing }, "sandbox_already_running");
    return { sandboxId: existing, created: false };
  }

  // APP_SOURCE_REPO = this app's own repo (ai-workflow)
  // GITHUB_REPO_OWNER/NAME = target repo for ticket implementation (ai-workflow-demo)
  const appRepo = process.env.APP_SOURCE_REPO;
  const githubToken = process.env.GITHUB_TOKEN;

  if (!appRepo || !githubToken) {
    throw createError({
      statusCode: 500,
      message: "APP_SOURCE_REPO (e.g. 'blazity/ai-workflow') and GITHUB_TOKEN are required",
    });
  }

  const sandbox = await Sandbox.create({
    source: {
      type: "git",
      url: `https://github.com/${appRepo}.git`,
      username: "x-access-token",
      password: githubToken,
    },
    runtime: "node22",
    resources: { vcpus: 2 },
    timeout: 3_600_000,
    env: buildSandboxEnv(),
  });

  const sandboxId = sandbox.sandboxId;
  logger.info({ sandboxId }, "sandbox_created");

  await sandbox.runCommand({
    cmd: "bash",
    args: ["-c", "corepack enable && pnpm install --frozen-lockfile && pnpm build && pnpm start"],
    cwd: "/vercel/sandbox",
    detached: true,
  });

  logger.info({ sandboxId }, "sandbox_app_started");

  return { sandboxId, created: true };
});
