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
    MAX_CONCURRENT_CONTAINERS: z
      .string()
      .default("3")
      .transform((v) => parseInt(v, 10))
      .pipe(z.number().int().positive()),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    JIRA_WEBHOOK_SECRET: z.string().min(1),
    COLUMN_AI: z.string().default("AI"),
    COLUMN_AI_IN_PROGRESS: z.string().default("AI In Progress"),
    COLUMN_AI_REVIEW: z.string().default("AI Review"),
    COLUMN_BACKLOG: z.string().default("Backlog"),
  },
  runtimeEnv: process.env,
});
