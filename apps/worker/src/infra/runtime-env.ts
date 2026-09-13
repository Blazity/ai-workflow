import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

// Environment parsing is infrastructure; higher tiers consume these resolved values.

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

    JIRA_BACKLOG_TRANSITION_ID: z.string().min(1).optional(),
    JIRA_AI_TRANSITION_ID: z.string().min(1).optional(),
    JIRA_AI_REVIEW_TRANSITION_ID: z.string().min(1).optional(),

    // VCS
    VCS_KIND: z.enum(["github", "gitlab"]).optional(),
    // Login of the bot's own VCS account. When set, PR reviews authored by it
    // are ignored so the bot does not trigger a run off its own review. The
    // provider-specific values take precedence in mixed-provider deployments.
    VCS_BOT_LOGIN: z.string().trim().min(1).optional(),
    GITHUB_BOT_LOGIN: z.string().trim().min(1).optional(),
    GITLAB_BOT_LOGIN: z.string().trim().min(1).optional(),
    // GitHub VCS — App auth (no PAT). Private key is base64-encoded PEM so it
    // round-trips cleanly through the Vercel env UI without newline-escaping.
    GITHUB_APP_ID: z.coerce.number().int().positive().optional(),
    GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
    GITHUB_INSTALLATION_ID: z.coerce.number().int().positive().optional(),
    GITHUB_OWNER: z.string().min(1).optional(),
    GITHUB_REPO: z.string().min(1).optional(),

    // GitLab VCS
    GITLAB_TOKEN: z.string().min(1).optional(),
    GITLAB_PROJECT_ID: z.string().min(1).optional(),
    /** Base URL for self-hosted GitLab. Defaults to https://gitlab.com. */
    GITLAB_HOST: z.string().url().default("https://gitlab.com"),

    // Messaging — Slack is optional. When token+channel are unset, a no-op
    // messaging adapter is used and workflow runs proceed silently.
    CHAT_SDK_SLACK_TOKEN: z.string().min(1).optional(),
    CHAT_SDK_CHANNEL_ID: z.string().min(1).optional(),
    CHAT_SDK_BOT_NAME: z.string().default("ai-workflow"),

    // Slack slash commands — required only if you register the /ai-workflow
    // slash command. When unset, /webhooks/slack rejects all requests.
    SLACK_SIGNING_SECRET: z.string().min(1).optional(),
    /** Comma-separated list of Slack user IDs allowed to invoke slash commands. Empty = anyone. */
    SLACK_ALLOWED_USER_IDS: z.string().optional(),

    // Agent
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    // Optional overrides for the git identity used inside the sandbox.
    // - GitHub: when both are unset, the identity is derived from the App so
    //   commits render with the App's avatar and the `[bot]` badge in the UI.
    // - GitLab: defaults to `ai-workflow-blazity` / `ai-workflow@blazity.com`.
    // Both must be set together to take effect; setting only one is an error.
    COMMIT_AUTHOR: z.string().min(1).optional(),
    COMMIT_EMAIL: z.string().min(1).optional(),

    // Codex auth is required when a stored harness selection chooses Codex.
    CODEX_API_KEY: z.string().min(1).optional(),
    CODEX_CHATGPT_OAUTH_TOKEN: z.string().min(1).optional(),

    // LiteLLM community-maintained pricing JSON. Operator overridable.
    CODEX_PRICING_URL: z
      .string()
      .url()
      .default("https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"),
    CODEX_PRICING_TTL_MS: z.coerce.number().int().positive().default(3_600_000),

    // Arthur AI Engine (optional: both required together). Enables the
    // in-sandbox tracer and the prompt-injection check. One task per run is
    // auto-created, so there is no static GENAI_ENGINE_TASK_ID.
    GENAI_ENGINE_API_KEY: z.string().min(1).optional(),
    GENAI_ENGINE_TRACE_ENDPOINT: z.string().url().optional(),

    // Remote MCP server
    MCP_SERVER_VERSION: z
      .string()
      .regex(
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
        "must be valid SemVer",
      )
      .default("0.1.0"),
    MCP_ALLOW_PUBLIC_DCR: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    MCP_DOGFOOD_FIXTURE_PREFIX: z.string().min(1).default("mcp-dogfood"),

    // Vercel (optional — auto via OIDC on Vercel)
    VERCEL_ENV: z.string().min(1).optional(),
    // The commit this deployment was built from, so /health can prove which
    // candidate an endpoint actually serves. A Vercel system variable: absent
    // when the project does not expose them, which /health reports as null
    // rather than guessing.
    VERCEL_GIT_COMMIT_SHA: z.string().min(1).optional(),
    VERCEL_TOKEN: z.string().min(1).optional(),
    VERCEL_TEAM_ID: z.string().min(1).optional(),
    VERCEL_PROJECT_ID: z.string().min(1).optional(),

    // Cron
    CRON_SECRET: z.string().min(1).optional(),

    // Jira Webhook
    JIRA_WEBHOOK_SECRET: z.string().min(1).optional(),

    // GitHub Webhook
    GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),

    // GitLab Webhook
    GITLAB_WEBHOOK_SECRET: z.string().min(1).optional(),

    // Webhook trigger blocks: 32-byte AES-256-GCM key (64 hex chars) that
    // encrypts per-endpoint signing secrets at rest. Intentionally optional:
    // without it the Webhook trigger is simply unavailable in the editor, and
    // making it required would break the boot of every deployment that does not
    // use the feature.
    WEBHOOK_TRIGGER_ENCRYPTION_KEY: z.string().min(1).optional(),

    // Neon Postgres (run registry + post-PR gate store) — auto-injected by
    // the Neon Vercel Marketplace integration, one branch per environment.
    DATABASE_URL: z.string().url(),

    // Better Auth (dashboard human login). The worker is the auth authority.
    BETTER_AUTH_SECRET: z.string().min(32, {
      message: "must be at least 32 characters",
    }),
    BETTER_AUTH_URL: z.string().url(),
    DASHBOARD_ORIGIN: z.string().url(),
    // Additional origins trusted for dashboard login on top of DASHBOARD_ORIGIN
    // (e.g. a preview deployment's stable alias). Comma-separated; each must be
    // a full origin URL. DASHBOARD_ORIGIN stays the single canonical origin used
    // for building links and SSO redirects.
    DASHBOARD_TRUSTED_ORIGINS: z
      .string()
      .optional()
      .transform((raw) => (raw ? raw.split(",").map((origin) => origin.trim()).filter(Boolean) : []))
      .pipe(z.array(z.string().url())),
    DASHBOARD_AUTH_EMAIL: z.string().email(),
    DASHBOARD_AUTH_PASSWORD: z.string().min(8, {
      message: "must be at least 8 characters",
    }),
    DASHBOARD_ORG_SLUG: z.string().min(1).default("ai-workflow"),
    SSO_ISSUER: z.string().url().optional(),
    SSO_ALLOWED_DOMAIN: z.string().min(1).optional(),
    SSO_CLIENT_ID: z.string().min(1).optional(),
    SSO_CLIENT_SECRET: z.string().min(1).optional(),
    RESEND_API_KEY: z.string().min(1).optional(),
    RESEND_FROM_EMAIL: z.string().email().optional(),
    RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),
  },
  createFinalSchema: (shape) => z.object(shape),
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

function hasAnyGithubProviderCredential(): boolean {
  return Boolean(env.GITHUB_APP_ID || env.GITHUB_APP_PRIVATE_KEY || env.GITHUB_INSTALLATION_ID);
}

function isGithubProviderConfigured(): boolean {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_INSTALLATION_ID);
}

// Cross-field validation — fail fast at startup instead of at first workflow
// step. Provider credentials are intentionally optional at the schema level:
// a deployment may configure GitHub, GitLab, or both.
{
  const hasAnyGithubCredential = hasAnyGithubProviderCredential();
  const hasGithubProvider = isGithubProviderConfigured();
  const hasGitLabProvider = Boolean(env.GITLAB_TOKEN);

  if (hasAnyGithubCredential && !hasGithubProvider) {
    throw new Error(
      "Invalid environment variables:\n" +
        "  GitHub provider requires GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_INSTALLATION_ID",
    );
  }
  if ((env.GITHUB_OWNER && !env.GITHUB_REPO) || (!env.GITHUB_OWNER && env.GITHUB_REPO)) {
    throw new Error(
      "Invalid environment variables:\n" +
        "  GITHUB_OWNER and GITHUB_REPO must be set together for legacy single-repo config",
    );
  }
  if (env.VCS_KIND === "github" && !hasGithubProvider) {
    throw new Error(
      "Invalid environment variables:\n" +
        "  VCS_KIND=github requires GitHub provider credentials",
    );
  }
  if (env.VCS_KIND === "gitlab" && !hasGitLabProvider) {
    throw new Error(
      "Invalid environment variables:\n" +
        "  VCS_KIND=gitlab requires GITLAB_TOKEN",
    );
  }
  if (!hasGithubProvider && !hasGitLabProvider) {
    throw new Error(
      "Invalid environment variables:\n" +
        "  At least one VCS provider must be configured",
    );
  }
  if (hasGithubProvider && !env.GITHUB_WEBHOOK_SECRET) {
    throw new Error(
      "Invalid environment variables:\n" +
        "  GitHub provider requires GITHUB_WEBHOOK_SECRET",
    );
  }
  if (hasGitLabProvider && !env.GITLAB_WEBHOOK_SECRET) {
    throw new Error(
      "Invalid environment variables:\n" +
        "  GitLab provider requires GITLAB_WEBHOOK_SECRET",
    );
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
  const ssoKeys = [
    env.SSO_ISSUER,
    env.SSO_ALLOWED_DOMAIN,
    env.SSO_CLIENT_ID,
    env.SSO_CLIENT_SECRET,
  ];
  if (ssoKeys.some(Boolean) && !ssoKeys.every(Boolean)) {
    throw new Error(
      "Invalid environment variables:\n" +
        "  SSO_ISSUER, SSO_ALLOWED_DOMAIN, SSO_CLIENT_ID, and SSO_CLIENT_SECRET must be set together",
    );
  }
  if (env.RESEND_API_KEY && !env.RESEND_FROM_EMAIL) {
    throw new Error(
      "Invalid environment variables:\n" +
        "  RESEND_API_KEY requires RESEND_FROM_EMAIL",
    );
  }
  if (env.RESEND_WEBHOOK_SECRET && !env.RESEND_API_KEY) {
    throw new Error(
      "Invalid environment variables:\n" +
        "  RESEND_WEBHOOK_SECRET requires RESEND_API_KEY",
    );
  }
  // Same rule as isValidWebhookEncryptionKey in src/infra/webhook-crypto.ts, which
  // cannot be imported here: runtime-env.ts must stay dependency-free at boot. Change
  // both together.
  if (
    env.WEBHOOK_TRIGGER_ENCRYPTION_KEY &&
    !/^[0-9a-fA-F]{64}$/.test(env.WEBHOOK_TRIGGER_ENCRYPTION_KEY)
  ) {
    throw new Error(
      "Invalid environment variables:\n" +
        "  WEBHOOK_TRIGGER_ENCRYPTION_KEY must be 64 hex characters (a 32-byte AES-256 key)",
    );
  }
}

export type Env = typeof env;
