import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().url(),
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
  },
  runtimeEnv: process.env,
});
