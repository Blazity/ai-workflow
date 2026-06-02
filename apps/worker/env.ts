import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import type { GitHubAppAuth } from "./src/lib/github-auth.js";

export const env = createEnv({
  onValidationError: (issues) => {
    const details = (issues as Array<{ path?: (string | number)[]; message: string }>)
      .map((i) => `  ${i.path?.join(".") ?? "unknown"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${details}`);
  },
  server: {
    // Issue Tracker
    ISSUE_TRACKER_KIND: z.literal("jira").default("jira"),
    JIRA_BASE_URL: z.string().url(),
    JIRA_API_TOKEN: z.string().min(1),
    JIRA_PROJECT_KEY: z.string().min(1),

    COLUMN_AI: z.string().min(1),
    COLUMN_AI_REVIEW: z.string().min(1),
    COLUMN_BACKLOG: z.string().min(1),

    // VCS
    VCS_KIND: z.enum(["github", "gitlab"]),
    // GitHub VCS — App auth (no PAT). Private key is base64-encoded PEM so it
    // round-trips cleanly through the Vercel env UI without newline-escaping.
    GITHUB_APP_ID: z.coerce.number().int().positive().optional(),
    GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
    GITHUB_INSTALLATION_ID: z.coerce.number().int().positive().optional(),
    GITHUB_OWNER: z.string().min(1).optional(),
    GITHUB_REPO: z.string().min(1).optional(),
    GITHUB_BASE_BRANCH: z.string().default("main"),

    // GitLab VCS
    GITLAB_TOKEN: z.string().min(1).optional(),
    GITLAB_PROJECT_ID: z.string().min(1).optional(),
    GITLAB_BASE_BRANCH: z.string().default("main"),
    /** Base URL for self-hosted GitLab. Defaults to https://gitlab.com. */
    GITLAB_HOST: z.string().url().default("https://gitlab.com"),

    // Messaging — Slack is optional. When token+channel are unset, a no-op
    // messaging adapter is used and workflow runs proceed silently.
    CHAT_SDK_SLACK_TOKEN: z.string().min(1).optional(),
    CHAT_SDK_CHANNEL_ID: z.string().min(1).optional(),
    CHAT_SDK_BOT_NAME: z.string().default("blazebot"),

    // Slack slash commands — required only if you register the /ai-workflow
    // slash command. When unset, /webhooks/slack rejects all requests.
    SLACK_SIGNING_SECRET: z.string().min(1).optional(),
    /** Comma-separated list of Slack user IDs allowed to invoke slash commands. Empty = anyone. */
    SLACK_ALLOWED_USER_IDS: z.string().optional(),

    // Agent
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    CLAUDE_MODEL: z.string().default("claude-opus-4-6"),
    // Optional overrides for the git identity used inside the sandbox.
    // - GitHub: when both are unset, the identity is derived from the App so
    //   commits render with the App's avatar and the `[bot]` badge in the UI.
    // - GitLab: defaults to `ai-workflow-blazity` / `ai-workflow@blazity.com`.
    // Both must be set together to take effect; setting only one is an error.
    COMMIT_AUTHOR: z.string().min(1).optional(),
    COMMIT_EMAIL: z.string().min(1).optional(),

    // Agent kind selection (claude | codex). Defaults to claude for back-compat.
    AGENT_KIND: z.enum(["claude", "codex"]).default("claude"),

    // Codex auth — at least one required when AGENT_KIND=codex.
    CODEX_API_KEY: z.string().min(1).optional(),
    CODEX_CHATGPT_OAUTH_TOKEN: z.string().min(1).optional(),

    // Codex model selection.
    CODEX_MODEL: z.string().default("gpt-5-codex"),

    // LiteLLM community-maintained pricing JSON. Operator overridable.
    CODEX_PRICING_URL: z
      .string()
      .url()
      .default("https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"),
    CODEX_PRICING_TTL_MS: z.coerce.number().int().positive().default(3_600_000),

    // Arthur AI Engine (optional — both required together). One task per run
    // is auto-created, so there is no static GENAI_ENGINE_TASK_ID.
    GENAI_ENGINE_API_KEY: z.string().min(1).optional(),
    GENAI_ENGINE_TRACE_ENDPOINT: z.string().url().optional(),
    GENAI_ENGINE_PROMPT_TASK_ID: z.string().uuid().optional(),

    // Sandbox
    MAX_CONCURRENT_AGENTS: z.coerce.number().int().positive().default(3),
    JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),

    // Attachments
    ATTACHMENT_MAX_FILE_SIZE_MB: z.coerce.number().int().positive().default(25),
    ATTACHMENT_MAX_TOTAL_SIZE_MB: z.coerce.number().int().positive().default(100),
    ATTACHMENT_MAX_COUNT: z.coerce.number().int().positive().default(20),
    ATTACHMENT_DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

    // Polling
    POLL_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),

    // Phase 3 (Review) — agent self-reviews diff and fixes issues before push.
    // Off by default so existing deployments keep current two-phase behavior.
    ENABLE_REVIEW_PHASE: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),

    // Vercel (optional — auto via OIDC on Vercel)
    VERCEL_ENV: z.string().min(1).optional(),
    VERCEL_TOKEN: z.string().min(1).optional(),
    VERCEL_TEAM_ID: z.string().min(1).optional(),
    VERCEL_PROJECT_ID: z.string().min(1).optional(),

    // Cron
    CRON_SECRET: z.string().min(1).optional(),

    // Jira Webhook
    JIRA_WEBHOOK_SECRET: z.string().min(1).optional(),

    // GitHub Webhook
    GITHUB_WEBHOOK_SECRET: z.string().min(1),

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
    if (
      !env.GITHUB_APP_ID ||
      !env.GITHUB_APP_PRIVATE_KEY ||
      !env.GITHUB_INSTALLATION_ID ||
      !env.GITHUB_OWNER ||
      !env.GITHUB_REPO
    ) {
      throw new Error(
        "Invalid environment variables:\n" +
          "  VCS_KIND=github requires GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_INSTALLATION_ID, GITHUB_OWNER, and GITHUB_REPO",
      );
    }
  }
  if (
    (env.COMMIT_AUTHOR && !env.COMMIT_EMAIL) ||
    (!env.COMMIT_AUTHOR && env.COMMIT_EMAIL)
  ) {
    throw new Error(
      "Invalid environment variables:\n" +
        "  COMMIT_AUTHOR and COMMIT_EMAIL must be set together (or both omitted to auto-derive on GitHub)",
    );
  }
  if (env.AGENT_KIND === "codex" && !env.CODEX_API_KEY && !env.CODEX_CHATGPT_OAUTH_TOKEN) {
    throw new Error(
      "Invalid environment variables:\n" +
        "  AGENT_KIND=codex requires CODEX_API_KEY or CODEX_CHATGPT_OAUTH_TOKEN",
    );
  }
  if (env.AGENT_KIND === "claude" && !env.ANTHROPIC_API_KEY) {
    throw new Error(
      "Invalid environment variables:\n" +
        "  AGENT_KIND=claude requires ANTHROPIC_API_KEY",
    );
  }
}

export type Env = typeof env;

/**
 * VCS config — discriminated on `kind`.
 * GitHub auth is App-based (mints short-lived installation tokens on demand).
 * GitLab auth is a static PAT (no App equivalent in this codebase).
 */
export type VcsConfig =
  | {
      kind: "github";
      auth: GitHubAppAuth;
      repoPath: string;
      baseBranch: string;
      host: string;
    }
  | {
      kind: "gitlab";
      token: string;
      repoPath: string;
      baseBranch: string;
      host: string;
    };

/** Resolve VCS config from env. Throws if required vars are missing for the active VCS_KIND. */
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
  if (
    !env.GITHUB_APP_ID ||
    !env.GITHUB_APP_PRIVATE_KEY ||
    !env.GITHUB_INSTALLATION_ID ||
    !env.GITHUB_OWNER ||
    !env.GITHUB_REPO
  ) {
    throw new Error(
      "GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_INSTALLATION_ID, GITHUB_OWNER, and GITHUB_REPO are required when VCS_KIND=github",
    );
  }
  return {
    kind: "github",
    auth: {
      appId: env.GITHUB_APP_ID,
      // Pass the base64 string through unchanged. The workflow body calls
      // getVcsConfig() to read baseBranch, and that runtime doesn't expose
      // Buffer or atob — so the decode happens at the use site (always inside
      // a Node step) in src/lib/github-auth.ts.
      privateKeyBase64: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_INSTALLATION_ID,
    },
    repoPath: `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`,
    baseBranch: env.GITHUB_BASE_BRANCH ?? "main",
    host: "https://github.com",
  };
}

/**
 * Resolve a fresh git-credential-shaped token for the configured VCS.
 * - GitLab: returns the static PAT.
 * - GitHub: mints a fresh ~1h installation access token via the App's JWT.
 *
 * Call this immediately before any operation that needs the raw token (git
 * push, Sandbox.create source.password). Do not cache the result outside the
 * operation that needs it.
 */
export async function getVcsToken(config: VcsConfig): Promise<string> {
  if (config.kind === "gitlab") return config.token;
  // Dynamic import keeps @octokit/* off the env-validation cold path. Modules
  // that only need env (e.g. Slack webhook handler) shouldn't transitively
  // load the GitHub App auth deps.
  const { mintInstallationToken } = await import("./src/lib/github-auth.js");
  return mintInstallationToken(config.auth);
}
