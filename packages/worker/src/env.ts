import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const workerEnv = createEnv({
  server: {
    MAX_CONCURRENT_AGENTS: z
      .string()
      .default("3")
      .transform((v) => parseInt(v, 10))
      .pipe(z.number().int().positive()),
    JIRA_BASE_URL: z.string().url().optional(),
    JIRA_USER_EMAIL: z.string().email().optional(),
    JIRA_API_TOKEN: z.string().min(1).optional(),
    JIRA_PROJECT_KEY: z.string().min(1),
    GITHUB_TOKEN: z.string().min(1).optional(),
    GITHUB_REPO_OWNER: z.string().min(1).optional(),
    GITHUB_REPO_NAME: z.string().min(1).optional(),
    GITHUB_BASE_BRANCH: z.string().default("main"),
    CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1),
    CLAUDE_MODEL: z.string().default("claude-opus-4-20250514"),
    DOCKER_IMAGE: z.string().default("blazebot-sandbox"),
    SANDBOX_MEMORY_MB: z
      .string()
      .default("4096")
      .transform((v) => parseInt(v, 10))
      .pipe(z.number().int().positive()),
    DEVELOPER_MODE: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    JOB_TIMEOUT_MS: z
      .string()
      .default("600000")
      .transform((v) => parseInt(v, 10))
      .pipe(z.number().int().positive()),
    POLL_INTERVAL_MS: z
      .string()
      .default("300000")
      .transform((v) => parseInt(v, 10))
      .pipe(z.number().int().positive()),
    STUCK_JOB_THRESHOLD_MS: z
      .string()
      .optional()
      .transform((v) => (v ? parseInt(v, 10) : undefined))
      .pipe(z.number().int().positive().optional()),
  },
  runtimeEnv: process.env,
});
