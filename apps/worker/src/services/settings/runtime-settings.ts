/**
 * The one place below the app tier that reads validated environment.
 *
 * ADR-001 wants `env` imported only by `config`, and the boundary baseline caps
 * how many service files may reach past that rule. Every service that needs a
 * deployment setting therefore takes it from a named accessor here instead of
 * importing `config/env.js` itself, so the tier violation is a single edge from
 * one file rather than one per consumer, and the settings each cluster actually
 * depends on are visible as a list instead of scattered `env.X` reads.
 *
 * Accessors are functions, not constants: the worker's tests replace the env
 * module per case, and a module-level snapshot would freeze the first value.
 */
import { env } from "../../config/env.js";

/** The run-slot ceiling every dispatch path shares. */
export function maxConcurrentAgents(): number {
  return env.MAX_CONCURRENT_AGENTS;
}

/** The shared secret the platform sends on scheduled cron invocations. */
export function cronSecret(): string | undefined {
  return env.CRON_SECRET;
}

/** Dashboard identity: the organization invites are minted for and its origin. */
export function dashboardOrganizationSettings(): {
  slug: string;
  name: string;
  origin: string;
} {
  return {
    slug: env.DASHBOARD_ORG_SLUG,
    name: env.DASHBOARD_ORG_NAME,
    origin: env.DASHBOARD_ORIGIN,
  };
}

/** MCP protocol limits and switches the transport and its services share. */
export function mcpSettings(): {
  enabled: boolean;
  serverVersion: string;
  allowPublicDcr: boolean;
  maxRequestBytes: number;
  maxResultBytes: number;
  toolTimeoutMs: number;
  readRateLimitPerMinute: number;
  mutationRateLimitPerMinute: number;
  auditRetentionDays: number;
} {
  return {
    enabled: env.MCP_ENABLED,
    serverVersion: env.MCP_SERVER_VERSION,
    allowPublicDcr: env.MCP_ALLOW_PUBLIC_DCR,
    maxRequestBytes: env.MCP_MAX_REQUEST_BYTES,
    maxResultBytes: env.MCP_MAX_RESULT_BYTES,
    toolTimeoutMs: env.MCP_TOOL_TIMEOUT_MS,
    readRateLimitPerMinute: env.MCP_READ_RATE_LIMIT_PER_MINUTE,
    mutationRateLimitPerMinute: env.MCP_MUTATION_RATE_LIMIT_PER_MINUTE,
    auditRetentionDays: env.MCP_AUDIT_RETENTION_DAYS,
  };
}

/** Where the dashboard lives, for links and for the auth cookie's origin. */
export function dashboardOrigin(): string {
  return env.DASHBOARD_ORIGIN;
}

/** Single sign-on wiring for the dashboard handoff. */
export function ssoSettings(): {
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  allowedDomain?: string;
} {
  return {
    issuer: env.SSO_ISSUER,
    clientId: env.SSO_CLIENT_ID,
    clientSecret: env.SSO_CLIENT_SECRET,
    allowedDomain: env.SSO_ALLOWED_DOMAIN,
  };
}

/** Deployment identity, as the platform exposes it to the running function. */
export function deploymentSettings(): {
  vercelEnv?: string;
  commitSha?: string;
} {
  return {
    vercelEnv: env.VERCEL_ENV,
    commitSha: env.VERCEL_GIT_COMMIT_SHA,
  };
}

/**
 * Every configured credential, for the redaction pass that runs over anything a
 * tool is about to publish. A value that is not set is not a secret to redact,
 * so unset entries are dropped rather than turning into an empty-string match
 * that would redact everything.
 */
export function configuredSecretValues(): string[] {
  return [
    env.JIRA_API_TOKEN,
    env.GITHUB_APP_PRIVATE_KEY,
    env.GITLAB_TOKEN,
    env.CHAT_SDK_SLACK_TOKEN,
    env.SLACK_SIGNING_SECRET,
    env.ANTHROPIC_API_KEY,
    env.CODEX_API_KEY,
    env.CODEX_CHATGPT_OAUTH_TOKEN,
    env.GENAI_ENGINE_API_KEY,
    env.VERCEL_TOKEN,
    env.CRON_SECRET,
    env.JIRA_WEBHOOK_SECRET,
    env.GITHUB_WEBHOOK_SECRET,
    env.GITLAB_WEBHOOK_SECRET,
    env.WEBHOOK_TRIGGER_ENCRYPTION_KEY,
    env.BETTER_AUTH_SECRET,
    env.SSO_CLIENT_SECRET,
    env.RESEND_API_KEY,
    env.RESEND_WEBHOOK_SECRET,
  ].filter((secret): secret is string => typeof secret === "string" && secret.length > 0);
}

/**
 * Which coding agent runs, and which optional phases the default workflow
 * carries. Read together because every caller that shapes a default definition
 * needs all three at once.
 */
export function agentRuntimeSettings(): {
  agentKind: typeof env.AGENT_KIND;
  includeReview: boolean;
  includeLeakReview: boolean;
} {
  return {
    agentKind: env.AGENT_KIND,
    includeReview: env.ENABLE_REVIEW_PHASE,
    includeLeakReview: env.ENABLE_LEAK_REVIEW,
  };
}

/**
 * The evaluation trace backend. Both halves are optional and a caller that has
 * only one of them cannot call anything, so they travel together.
 */
export function evaluationTraceSettings(): {
  endpoint?: string;
  apiKey?: string;
} {
  return {
    endpoint: env.GENAI_ENGINE_TRACE_ENDPOINT,
    apiKey: env.GENAI_ENGINE_API_KEY,
  };
}

/** The secret the OAuth flow cookie is signed with. */
export function betterAuthSecret(): string {
  return env.BETTER_AUTH_SECRET;
}

/** The base URL Better Auth mounts under; the MCP issuer is derived from it. */
export function betterAuthBaseUrl(): string {
  return env.BETTER_AUTH_URL;
}
