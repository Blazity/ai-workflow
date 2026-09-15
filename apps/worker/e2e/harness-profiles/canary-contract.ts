import { z } from "zod";

// Fixture identity (definition ids, the custom profile pin, its skill, one
// ticket per fixture) lives in engine-canary-fixtures.ts, not here. The canary
// observes the target only through MCP, so no database connection string is
// part of this contract either. This schema is intentionally permissive about
// unknown keys: it parses process.env, which carries names this contract never
// claimed (PATH, CI, GITHUB_*, and a connection string a job may still
// forward), and zod's default object mode strips those rather than rejecting
// them.
const schema = z
  .object({
    HARNESS_CANARY_BASE_URL: z.string().url(),
    HARNESS_CANARY_EXPECTED_HOST: z.string().trim().min(1),
    ENGINE_CANARY_MCP_CLIENT_ID: z.string().trim().min(1),
    ENGINE_CANARY_MCP_CLIENT_SECRET: z.string().min(20),
    HARNESS_CANARY_CONFIRM_PREVIEW_MUTATIONS: z.literal(
      "run-preview-harness-canary",
    ),
    VERCEL_ENV: z.literal("preview"),
    VERCEL_AUTOMATION_BYPASS_SECRET: z.string().min(1),
    NEXT_PUBLIC_HARNESS_PROFILE_AUTHORING_ENABLED: z.union([
      z.literal("0"),
      z.literal("false"),
    ]),
    HARNESS_CANARY_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(3_600_000)
      .default(900_000),
  })
  .superRefine((value, context) => {
    const base = new URL(value.HARNESS_CANARY_BASE_URL);
    if (base.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        path: ["HARNESS_CANARY_BASE_URL"],
        message: "The canary must target an HTTPS preview",
      });
    }
    if (base.host !== value.HARNESS_CANARY_EXPECTED_HOST) {
      context.addIssue({
        code: "custom",
        path: ["HARNESS_CANARY_EXPECTED_HOST"],
        message: `Expected ${value.HARNESS_CANARY_EXPECTED_HOST}, received ${base.host}`,
      });
    }
  });

export type HarnessCanaryEnv = z.infer<typeof schema>;

export function parseHarnessCanaryEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
): HarnessCanaryEnv {
  return schema.parse(source);
}
