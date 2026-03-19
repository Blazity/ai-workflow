import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const apiEnv = createEnv({
  server: {
    PORT: z
      .string()
      .default("3000")
      .transform((v) => parseInt(v, 10)),
    JIRA_WEBHOOK_SECRET: z.string().min(1),
  },
  runtimeEnv: process.env,
});
