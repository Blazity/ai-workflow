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
    VCS_KIND: z.enum(["github", "gitlab"]),
    GITHUB_TOKEN: z.string().min(1).optional(),
    GITHUB_OWNER: z.string().min(1).optional(),
    GITHUB_REPO: z.string().min(1).optional(),
    GITHUB_BASE_BRANCH: z.string().default("main"),

    // GitLab VCS
    GITLAB_TOKEN: z.string().min(1).optional(),
    GITLAB_PROJECT_ID: z.string().min(1).optional(),
    GITLAB_BASE_BRANCH: z.string().default("main"),
    /** Base URL for self-hosted GitLab. Defaults to https://gitlab.com. */
    GITLAB_HOST: z.string().url().default("https://gitlab.com"),

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

// Cross-field validation — fail fast at startup instead of at first workflow
// step. createEnv() validates each field individually; provider-specific
// credentials are intentionally optional at the schema level (only one VCS is
// active at a time) so we enforce the conditional requirement here.
{
  if (env.VCS_KIND === "gitlab") {
    if (!env.GITLAB_TOKEN || !env.GITLAB_PROJECT_ID) {
      throw new Error(
        "Invalid environment variables:\n" +
          "  VCS_KIND=gitlab requires GITLAB_TOKEN and GITLAB_PROJECT_ID",
      );
    }
  } else if (env.VCS_KIND === "github") {
    if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) {
      throw new Error(
        "Invalid environment variables:\n" +
          "  VCS_KIND=github requires GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO",
      );
    }
  }
}

export type Env = typeof env;

export interface VcsConfig {
  kind: "github" | "gitlab";
  token: string;
  repoPath: string;
  baseBranch: string;
  /** Base URL for the VCS host (e.g. https://gitlab.example.com or https://github.com). */
  host: string;
}

/** Resolve VCS credentials from env. Throws if required vars are missing for the active VCS_KIND. */
export function getVcsConfig(): VcsConfig {
  if (env.VCS_KIND === "gitlab") {
    if (!env.GITLAB_TOKEN || !env.GITLAB_PROJECT_ID) {
      throw new Error("GITLAB_TOKEN and GITLAB_PROJECT_ID are required when VCS_KIND=gitlab");
    }
    return {
      kind: "gitlab",
      token: env.GITLAB_TOKEN,
      repoPath: env.GITLAB_PROJECT_ID,
      baseBranch: env.GITLAB_BASE_BRANCH ?? "main",
      host: env.GITLAB_HOST,
    };
  }
  if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) {
    throw new Error("GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO are required when VCS_KIND=github");
  }
  return {
    kind: "github",
    token: env.GITHUB_TOKEN,
    repoPath: `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`,
    baseBranch: env.GITHUB_BASE_BRANCH ?? "main",
    host: "https://github.com",
  };
}
