import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    PORT: z
      .string()
      .default("3000")
      .transform((v) => parseInt(v, 10)),
    MAX_CONCURRENT_AGENTS: z
      .string()
      .default("3")
      .transform((v) => parseInt(v, 10))
      .pipe(z.number().int().positive()),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    JIRA_WEBHOOK_SECRET: z.string().min(1),
    COLUMN_AI: z.string().default("AI"),
    ISSUE_TRACKER_KIND: z.enum(["jira", "linear"]).default("jira"),
    MESSAGING_KIND: z.enum(["slack"]).default("slack"),
    VCS_KIND: z.enum(["github"]).default("github"),
    JOB_TIMEOUT_MS: z
      .string()
      .default("600000")
      .transform((v) => parseInt(v, 10))
      .pipe(z.number().int().positive()),
    JIRA_BASE_URL: z.string().url().optional(),
    JIRA_USER_EMAIL: z.string().email().optional(),
    JIRA_API_TOKEN: z.string().min(1).optional(),
    GITHUB_TOKEN: z.string().min(1).optional(),
    GITHUB_REPO_OWNER: z.string().min(1).optional(),
    GITHUB_REPO_NAME: z.string().min(1).optional(),
    GITHUB_BASE_BRANCH: z.string().default("main"),
    CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1),
    CLAUDE_MODEL: z.string().default("claude-sonnet-4-20250514"),
    COLUMN_AI_REVIEW: z.string().default("AI Review"),
    COLUMN_BACKLOG: z.string().default("Backlog"),
    DOCKER_IMAGE: z.string().default("blazebot-sandbox"),
    SANDBOX_MEMORY_MB: z
      .string()
      .default("4096")
      .transform((v) => parseInt(v, 10))
      .pipe(z.number().int().positive()),
  },
  runtimeEnv: process.env,
});
