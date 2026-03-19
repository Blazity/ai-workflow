import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url().optional(),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    COLUMN_AI: z.string().default("AI"),
    COLUMN_AI_REVIEW: z.string().default("AI Review"),
    COLUMN_BACKLOG: z.string().default("Backlog"),
    ISSUE_TRACKER_KIND: z.enum(["jira", "linear"]).default("jira"),
    MESSAGING_KIND: z.enum(["slack"]).default("slack"),
    SLACK_BOT_TOKEN: z.string().min(1).optional(),
    SLACK_DEFAULT_CHANNEL: z.string().min(1).optional(),
    VCS_KIND: z.enum(["github"]).default("github"),
    JOB_MAX_RETRIES: z
      .string()
      .default("3")
      .transform((v) => parseInt(v, 10))
      .pipe(z.number().int().nonnegative()),
    JOB_BACKOFF_MS: z
      .string()
      .default("30000")
      .transform((v) => parseInt(v, 10))
      .pipe(z.number().int().positive())
      .optional(),
  },
  runtimeEnv: process.env,
});
