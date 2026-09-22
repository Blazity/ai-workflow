import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { isValidIntegrationSecretsKey } from "./secrets-key-format.js";

// Environment parsing is infrastructure; higher tiers consume these resolved values.

export const env = createEnv({
  onValidationError: (issues) => {
    const details = (issues as Array<{ path?: (string | number)[]; message: string }>)
      .map((i) => `  ${i.path?.join(".") ?? "unknown"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${details}`);
  },
  server: {
    // The issue tracker's site, credentials, project and transitions left this
    // file in S12: they are the connection of the integration serving the
    // `issue_tracker` capability, which reads the same variable names, so a
    // deployment configured through its environment needs no change. A
    // deployment with no tracker connected at all now boots, which it could
    // not before; the loud failure a required project key used to give at boot
    // is the tracker's own `project` health check.

    // VCS
    // Login of the bot's own automation account, for a deployment with exactly
    // one version control provider. Every provider's own variables belong to
    // its integration; this one is declared here because it spans them, and it
    // is read through whichever integration claims it as `legacyBotLogin`,
    // never directly. See RESERVED_ENVIRONMENT_VARIABLES in the SDK.
    VCS_BOT_LOGIN: z.string().trim().min(1).optional(),

    // Agent
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    // Optional overrides for the git identity used inside the sandbox.
    // When both are unset the identity comes from the version control
    //   provider's own automation account, so commits render as that account.
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

    // Webhook trigger blocks: 32-byte AES-256-GCM key (64 hex chars) that
    // encrypts per-endpoint signing secrets at rest. Intentionally optional:
    // without it the Webhook trigger is simply unavailable in the editor, and
    // making it required would break the boot of every deployment that does not
    // use the feature.
    WEBHOOK_TRIGGER_ENCRYPTION_KEY: z.string().min(1).optional(),
    /** Encrypts the connection secrets an admin stores from the dashboard. Its
     *  own key, never the webhook key: see infra/secrets-crypto.ts. */
    INTEGRATION_SECRETS_KEY: z.string().min(1).optional(),

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

// Cross-field validation — fail fast at startup instead of at first workflow
// step. Provider credentials are intentionally optional at the schema level:
// provider credentials are intentionally optional at the schema level because
// integration-owned providers validate their own connection settings.
{
  if (
    (env.COMMIT_AUTHOR && !env.COMMIT_EMAIL) ||
    (!env.COMMIT_AUTHOR && env.COMMIT_EMAIL)
  ) {
    throw new Error(
      "Invalid environment variables:\n" +
        "  COMMIT_AUTHOR and COMMIT_EMAIL must be set together (or both omitted, to take the automation account of the version control provider)",
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
  // Refused at boot rather than at the moment an admin presses Save: a key that
  // cannot decrypt is the same as no key, and finding that out while connecting
  // an integration would look like the credential being wrong. The rule comes
  // from the module the cipher reads it from, so the two cannot drift.
  if (env.INTEGRATION_SECRETS_KEY && !isValidIntegrationSecretsKey(env.INTEGRATION_SECRETS_KEY)) {
    throw new Error(
      "Invalid environment variables:\n" +
        "  INTEGRATION_SECRETS_KEY must be 64 hex characters (a 32-byte AES-256 key)",
    );
  }
}

export type Env = typeof env;
