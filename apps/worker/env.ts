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
    JIRA_BACKLOG_TRANSITION_ID: z.string().min(1).optional(),
    JIRA_AI_REVIEW_TRANSITION_ID: z.string().min(1).optional(),

    // VCS
    VCS_KIND: z.enum(["github", "gitlab"]).optional(),
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

    // Review phase: agent self-reviews its diff and fixes issues before push.
    // Off by default so existing deployments keep current two-phase behavior.
    // This flag no longer gates execution directly; it only shapes the built-in
    // default workflow definition (the includeReview input). Once a definition
    // is saved via the dashboard, a review_agent block's presence drives it.
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
    GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),

    // GitLab Webhook
    GITLAB_WEBHOOK_SECRET: z.string().min(1).optional(),

    // Neon Postgres (run registry + post-PR gate store) — auto-injected by
    // the Neon Vercel Marketplace integration, one branch per environment.
    DATABASE_URL: z.string().url(),

    // Better Auth (dashboard human login). The worker is the auth authority.
    BETTER_AUTH_SECRET: z.string().min(32, {
      message: "must be at least 32 characters",
    }),
    BETTER_AUTH_URL: z.string().url(),
    DASHBOARD_ORIGIN: z.string().url(),
    DASHBOARD_AUTH_EMAIL: z.string().email(),
    DASHBOARD_AUTH_PASSWORD: z.string().min(8, {
      message: "must be at least 8 characters",
    }),
    DASHBOARD_ORG_NAME: z.string().min(1).default("AI Workflow"),
    DASHBOARD_ORG_SLUG: z.string().min(1).default("ai-workflow"),
    SSO_ISSUER: z.string().url().optional(),
    SSO_ALLOWED_DOMAIN: z.string().min(1).optional(),
    SSO_CLIENT_ID: z.string().min(1).optional(),
    SSO_CLIENT_SECRET: z.string().min(1).optional(),
    RESEND_API_KEY: z.string().min(1).optional(),
    RESEND_FROM_EMAIL: z.string().email().optional(),
    RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

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
}

export type Env = typeof env;

/**
 * VCS config — discriminated on `kind`.
 * GitHub auth is App-based (mints short-lived installation tokens on demand).
 * GitLab auth is a static PAT (no App equivalent in this codebase).
 */
export type VcsProviderConfig =
  | {
      kind: "github";
      auth: GitHubAppAuth;
      host: string;
      legacyRepoPath?: string;
      legacyBaseBranch: string;
    }
  | {
      kind: "gitlab";
      token: string;
      host: string;
      legacyRepoPath?: string;
      legacyBaseBranch: string;
    };

type LegacyVcsConfig<T extends VcsProviderConfig> = T extends unknown
  ? Omit<T, "legacyRepoPath" | "legacyBaseBranch"> & {
      repoPath: string;
      baseBranch: string;
    }
  : never;

export type VcsConfig = LegacyVcsConfig<VcsProviderConfig>;

export type VcsProviderKind = VcsProviderConfig["kind"];

function hasAnyGithubProviderCredential(): boolean {
  return Boolean(env.GITHUB_APP_ID || env.GITHUB_APP_PRIVATE_KEY || env.GITHUB_INSTALLATION_ID);
}

function isGithubProviderConfigured(): boolean {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_INSTALLATION_ID);
}

/** Resolve every provider configured by credentials. */
export function getConfiguredVcsProviders(): VcsProviderConfig[] {
  const providers: VcsProviderConfig[] = [];

  if (isGithubProviderConfigured()) {
    providers.push({
      kind: "github",
      auth: {
        appId: env.GITHUB_APP_ID!,
        privateKeyBase64: env.GITHUB_APP_PRIVATE_KEY!,
        installationId: env.GITHUB_INSTALLATION_ID!,
      },
      host: "https://github.com",
      ...(env.GITHUB_OWNER && env.GITHUB_REPO
        ? { legacyRepoPath: `${env.GITHUB_OWNER}/${env.GITHUB_REPO}` }
        : {}),
      legacyBaseBranch: env.GITHUB_BASE_BRANCH ?? "main",
    });
  }

  if (env.GITLAB_TOKEN) {
    providers.push({
      kind: "gitlab",
      token: env.GITLAB_TOKEN,
      host: env.GITLAB_HOST,
      ...(env.GITLAB_PROJECT_ID ? { legacyRepoPath: env.GITLAB_PROJECT_ID } : {}),
      legacyBaseBranch: env.GITLAB_BASE_BRANCH ?? "main",
    });
  }

  return providers;
}

export function getVcsProviderConfig(kind: VcsProviderKind): VcsProviderConfig {
  const provider = getConfiguredVcsProviders().find((candidate) => candidate.kind === kind);
  if (!provider) {
    throw new Error(`VCS provider is not configured: ${kind}`);
  }
  return provider;
}

/** Resolve legacy single-repo VCS config. New multi-repo code should use provider configs. */
export function getVcsConfig(): VcsConfig {
  const providers = getConfiguredVcsProviders();
  const selectedProvider =
    env.VCS_KIND
      ? providers.find((provider) => provider.kind === env.VCS_KIND)
      : providers.length === 1
        ? providers[0]
        : undefined;

  if (!selectedProvider) {
    throw new Error("legacy VCS config requires exactly one selected provider");
  }
  if (!selectedProvider.legacyRepoPath) {
    throw new Error("legacy VCS config requires a repository");
  }

  if (selectedProvider.kind === "gitlab") {
    return {
      kind: "gitlab",
      token: selectedProvider.token,
      repoPath: selectedProvider.legacyRepoPath,
      baseBranch: selectedProvider.legacyBaseBranch,
      host: selectedProvider.host,
    };
  }
  return {
    kind: "github",
    auth: selectedProvider.auth,
    repoPath: selectedProvider.legacyRepoPath,
    baseBranch: selectedProvider.legacyBaseBranch,
    host: selectedProvider.host,
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
export async function getVcsToken(config: VcsProviderConfig): Promise<string> {
  if (config.kind === "gitlab") return config.token;
  // Dynamic import keeps @octokit/* off the env-validation cold path. Modules
  // that only need env (e.g. Slack webhook handler) shouldn't transitively
  // load the GitHub App auth deps.
  const { mintInstallationToken } = await import("./src/lib/github-auth.js");
  return mintInstallationToken(config.auth);
}
