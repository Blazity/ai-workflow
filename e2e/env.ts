import { z } from "zod";

const schema = z.object({
  E2E_BASE_URL: z.string().url(),

  JIRA_BASE_URL: z.string().url(),
  JIRA_EMAIL: z.string().email(),
  JIRA_API_TOKEN: z.string().min(1),
  JIRA_PROJECT_KEY: z.string().min(1),
  JIRA_WEBHOOK_SECRET: z.string().min(1),
  COLUMN_AI: z.string().min(1),
  COLUMN_AI_REVIEW: z.string().min(1),
  COLUMN_BACKLOG: z.string().min(1),

  GITHUB_TOKEN: z.string().min(1),
  GITHUB_OWNER: z.string().min(1),
  GITHUB_REPO: z.string().min(1),

  CRON_SECRET: z.string().min(1),

  AI_WORKFLOW_KV_REST_API_URL: z.string().url(),
  AI_WORKFLOW_KV_REST_API_TOKEN: z.string().min(1),

  VERCEL_AUTOMATION_BYPASS_SECRET: z.string().optional(),
});

export type E2EEnv = z.infer<typeof schema>;

let _parsed: E2EEnv | undefined;

/** Lazily parsed so vitest can collect test files without env vars set. */
export const e2eEnv = new Proxy({} as E2EEnv, {
  get(_, prop: string) {
    if (!_parsed) _parsed = schema.parse(process.env);
    return _parsed[prop as keyof E2EEnv];
  },
});
