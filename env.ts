import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  onValidationError: (issues) => {
    const details = (issues as Array<{ path?: (string | number)[]; message: string }>)
      .map((i) => `  ${i.path?.join(".") ?? "unknown"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${details}`);
  },
  server: {
    // Issue Tracker
    ISSUE_TRACKER_KIND: z.enum(["jira"]),
    JIRA_BASE_URL: z.string().url(),
    JIRA_EMAIL: z.string().email(),
    JIRA_API_TOKEN: z.string().min(1),
    JIRA_PROJECT_KEY: z.string().min(1),

    COLUMN_AI: z.string().min(1),
    COLUMN_AI_REVIEW: z.string().min(1),
    COLUMN_BACKLOG: z.string().min(1),

    // VCS
    VCS_KIND: z.enum(["github"]),
    GITHUB_TOKEN: z.string().min(1),
    GITHUB_OWNER: z.string().min(1),
    GITHUB_REPO: z.string().min(1),
    GITHUB_BASE_BRANCH: z.string().default("main"),

    // Messaging
    CHAT_SDK_SLACK_TOKEN: z.string().min(1),
    CHAT_SDK_CHANNEL_ID: z.string().min(1),
    CHAT_SDK_BOT_NAME: z.string().default("blazebot"),

    // Agent
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1).optional(),
    CLAUDE_MODEL: z.string().default("claude-opus-4-6"),
    COMMIT_AUTHOR: z.string().default("ai-workflow-blazity"),
    COMMIT_EMAIL: z.string().default("ai-workflow@blazity.com"),

    // Sandbox
    MAX_CONCURRENT_AGENTS: z.coerce.number().int().positive().default(3),
    JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),

    // Polling
    POLL_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),

    // Vercel (optional — auto via OIDC on Vercel)
    VERCEL_TOKEN: z.string().min(1).optional(),
    VERCEL_TEAM_ID: z.string().min(1).optional(),
    VERCEL_PROJECT_ID: z.string().min(1).optional(),

    // Cron
    CRON_SECRET: z.string().min(1).optional(),

    // Jira Webhook
    JIRA_WEBHOOK_SECRET: z.string().min(1).optional(),

    // Redis (run registry)
    AI_WORKFLOW_KV_REST_API_URL: z.string().url(),
    AI_WORKFLOW_KV_REST_API_TOKEN: z.string().min(1),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

export type Env = typeof env;
