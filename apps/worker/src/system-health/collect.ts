import type {
  SystemHealthCheck,
  SystemHealthEvidenceSource,
  SystemHealthGroup,
  SystemHealthIntegration,
  SystemHealthMode,
  SystemHealthResponse,
} from "@shared/contracts";

export type SystemHealthConfig = {
  databaseUrl?: string;
  jiraBaseUrl?: string;
  jiraApiToken?: string;
  jiraProjectKey?: string;
  jiraWebhookSecret?: string;
  githubAppId?: number;
  githubAppPrivateKey?: string;
  githubInstallationId?: number;
  githubWebhookSecret?: string;
  gitlabToken?: string;
  gitlabHost?: string;
  gitlabWebhookSecret?: string;
  gitlabProjectId?: string;
  agentKind: "claude" | "codex";
  anthropicApiKey?: string;
  anthropicModel?: string;
  codexApiKey?: string;
  codexOauthToken?: string;
  codexModel?: string;
  betterAuthSecret?: string;
  betterAuthUrl?: string;
  dashboardOrigin?: string;
  ssoIssuer?: string;
  ssoAllowedDomain?: string;
  ssoClientId?: string;
  ssoClientSecret?: string;
  resendApiKey?: string;
  resendFromEmail?: string;
  resendWebhookSecret?: string;
  slackToken?: string;
  slackChannelId?: string;
  slackSigningSecret?: string;
  slackAllowedUserIds?: string;
  arthurApiKey?: string;
  arthurTraceEndpoint?: string;
  mcpEnabled: boolean;
  webhookTriggerEncryptionKey?: string;
  vercelToken?: string;
  vercelTeamId?: string;
  vercelProjectId?: string;
};

export type SystemHealthProbeResult = {
  mode?: Extract<
    SystemHealthMode,
    "live" | "down" | "degraded" | "configured" | "not-configured"
  >;
  message?: string;
  evidenceSource?: SystemHealthEvidenceSource;
  observedAt?: string;
  coverage?: { checked: number; total: number };
};

export type SystemHealthProbe = (
  signal: AbortSignal,
) => Promise<SystemHealthProbeResult | void>;

/** Keys are `${integrationId}.${checkId}` so capabilities can be tested and
 * timed independently without flattening a provider back into one probe. */
export type SystemHealthProbes = Partial<Record<string, SystemHealthProbe>>;

const PROBE_TIMEOUT_MS = 4_000;

type CheckBase = Omit<
  SystemHealthCheck,
  "checkedAt" | "observedAt" | "latencyMs" | "coverage"
>;

type IntegrationDefinition = {
  id: string;
  label: string;
  group: SystemHealthGroup;
  critical: boolean;
  checks: CheckBase[];
};

export async function collectSystemHealth(input: {
  config: SystemHealthConfig;
  probes: SystemHealthProbes;
  now?: () => Date;
  monotonicNow?: () => number;
}): Promise<SystemHealthResponse> {
  const now = input.now ?? (() => new Date());
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  const generatedAt = now().toISOString();
  const definitions = healthDefinitions(input.config);

  const integrations = await Promise.all(
    definitions.map(async (definition): Promise<SystemHealthIntegration> => {
      const checks = await Promise.all(
        definition.checks.map((check) =>
          probedCheck(
            check,
            input.probes[`${definition.id}.${check.id}`],
            monotonicNow,
            generatedAt,
          ),
        ),
      );
      const mode = integrationMode(checks);
      const pingCheck = checks.find(
        (check) =>
          check.latencyMs !== undefined &&
          (check.mode === "live" || check.mode === "down"),
      );
      return {
        id: definition.id,
        label: definition.label,
        group: definition.group,
        critical: definition.critical,
        envVars: [...new Set(checks.flatMap((check) => check.envVars))],
        mode,
        configError: checks
          .filter((check) => check.mode === "misconfigured")
          .map((check) => check.message)
          .filter((message): message is string => Boolean(message))
          .join(" ") || undefined,
        ping: pingCheck
          ? {
              ok: pingCheck.mode === "live",
              latencyMs: pingCheck.latencyMs ?? 0,
              ...(pingCheck.mode === "down" && pingCheck.message
                ? { error: pingCheck.message }
                : {}),
            }
          : null,
        checks,
      };
    }),
  );

  const checks = integrations.flatMap((integration) => integration.checks);
  return {
    generatedAt,
    summary: {
      total: integrations.length,
      live: integrations.filter((entry) => entry.mode === "live").length,
      down: integrations.filter((entry) => entry.mode === "down").length,
      notConfigured: integrations.filter(
        (entry) => entry.mode === "not-configured",
      ).length,
      criticalDown: integrations.filter(
        (entry) =>
          entry.critical &&
          (entry.mode === "down" || entry.mode === "misconfigured"),
      ).length,
      checksTotal: checks.length,
      checksLive: checks.filter((check) => check.mode === "live").length,
      checksDown: checks.filter((check) => check.mode === "down").length,
      checksDegraded: checks.filter((check) => check.mode === "degraded").length,
    },
    integrations,
  };
}

function healthDefinitions(config: SystemHealthConfig): IntegrationDefinition[] {
  const githubCredentialsMode = groupedMode([
    config.githubAppId,
    config.githubAppPrivateKey,
    config.githubInstallationId,
  ]);
  const githubAppMode =
    githubCredentialsMode === "not-configured" && config.githubWebhookSecret
      ? "misconfigured"
      : githubCredentialsMode;
  const gitlabApiMode: SystemHealthMode = config.gitlabToken
    ? "configured"
    : config.gitlabProjectId || config.gitlabWebhookSecret
      ? "misconfigured"
      : "not-configured";
  const jiraApiMode = requiredMode([
    config.jiraBaseUrl,
    config.jiraApiToken,
    config.jiraProjectKey,
  ]);
  const authMode = requiredMode([
    config.betterAuthSecret,
    config.betterAuthUrl,
    config.dashboardOrigin,
  ]);
  const ssoLoginMode = groupedMode([
    config.ssoIssuer,
    config.ssoAllowedDomain,
    config.ssoClientId,
    config.ssoClientSecret,
  ]);
  const ssoDiscoveryMode: SystemHealthMode = config.ssoIssuer
    ? "configured"
    : ssoLoginMode === "not-configured"
      ? "not-configured"
      : "misconfigured";
  const ssoClientMode =
    ssoLoginMode === "not-configured"
      ? "not-configured"
      : groupedMode(
          [config.ssoAllowedDomain, config.ssoClientId, config.ssoClientSecret],
          "misconfigured",
        );
  const emailCredentialsMode = groupedMode([
    config.resendApiKey,
    config.resendFromEmail,
  ]);
  const emailMode =
    config.resendWebhookSecret && emailCredentialsMode === "not-configured"
      ? "misconfigured"
      : emailCredentialsMode;
  const slackHasAnyConfig = Boolean(
    config.slackToken || config.slackChannelId || config.slackSigningSecret,
  );
  const slackBotMode: SystemHealthMode = config.slackToken
    ? "configured"
    : slackHasAnyConfig
      ? "misconfigured"
      : "mock";
  const slackChannelMode: SystemHealthMode =
    config.slackToken && config.slackChannelId
      ? "configured"
      : slackHasAnyConfig
        ? "misconfigured"
        : "mock";
  const arthurMode = groupedMode([config.arthurApiKey, config.arthurTraceEndpoint]);
  const vercelMode = groupedMode([
    config.vercelToken,
    config.vercelTeamId,
    config.vercelProjectId,
  ]);
  const agentMode: SystemHealthMode =
    config.agentKind === "claude"
      ? requiredMode([config.anthropicApiKey, config.anthropicModel])
      : requiredMode([
          config.codexApiKey || config.codexOauthToken,
          config.codexModel,
        ]);

  return [
    integration("database", "Database", "core", true, [
      configured("configuration", "Configuration", ["DATABASE_URL"], config.databaseUrl),
      checked("connectivity", "Connection and query", ["DATABASE_URL"], config.databaseUrl ? "configured" : "misconfigured", true),
    ]),
    integration("jira", "Jira", "core", true, [
      checked("api", "Account, project and statuses", ["JIRA_BASE_URL", "JIRA_API_TOKEN", "JIRA_PROJECT_KEY"], jiraApiMode, true),
      checked("webhook-delivery", "Webhook registration and delivery", ["JIRA_WEBHOOK_SECRET"], optionalValueMode(config.jiraWebhookSecret), false, "provider-config"),
    ]),
    integration("github", "GitHub", "core", true, [
      checked("app-installation", "App installation", ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_INSTALLATION_ID"], githubAppMode, true),
      checked("repositories", "Repository access", ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_INSTALLATION_ID"], githubAppMode, true),
      checked("webhook-delivery", "App webhook configuration and deliveries", ["GITHUB_WEBHOOK_SECRET"], dependentOptionalMode(githubAppMode, config.githubWebhookSecret), true, "provider-delivery"),
    ]),
    integration("gitlab", "GitLab", "core", true, [
      checked("api", "API identity", ["GITLAB_TOKEN", "GITLAB_HOST"], gitlabApiMode, true),
      checked("repositories", "Repository access", ["GITLAB_TOKEN", "GITLAB_HOST", "GITLAB_PROJECT_ID"], gitlabApiMode, true),
      checked("webhook-delivery", "Project webhook test delivery", ["GITLAB_WEBHOOK_SECRET"], dependentOptionalMode(gitlabApiMode, config.gitlabWebhookSecret), true, "provider-delivery"),
    ]),
    integration("agent", config.agentKind === "claude" ? "Claude agent" : "Codex agent", "core", true, [
      checked("model", "Credentials and configured model", config.agentKind === "claude" ? ["AGENT_KIND", "ANTHROPIC_API_KEY", "CLAUDE_MODEL"] : ["AGENT_KIND", "CODEX_API_KEY", "CODEX_CHATGPT_OAUTH_TOKEN", "CODEX_MODEL"], agentMode, true),
    ]),
    integration("dashboard-auth", "Dashboard authentication", "auth-email", true, [
      configured("configuration", "URL, origin and session secret", ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "DASHBOARD_ORIGIN"], authMode === "configured", authMode),
      fixed("session", "Protected session enforcement", "live", true, "This protected request has an authorized admin session."),
    ]),
    integration("sso", "Single sign-on", "auth-email", false, [
      checked("discovery", "OIDC discovery and issuer", ["SSO_ISSUER"], ssoDiscoveryMode, true),
      configured("client", "Client credentials and allowed domain", ["SSO_CLIENT_ID", "SSO_CLIENT_SECRET", "SSO_ALLOWED_DOMAIN"], ssoClientMode === "configured", ssoClientMode),
    ]),
    integration("email", "Email delivery", "auth-email", false, [
      checked("sender", "API and sender domain", ["RESEND_API_KEY", "RESEND_FROM_EMAIL"], emailMode, true),
      checked("webhook-delivery", "Delivery-status webhook", ["RESEND_WEBHOOK_SECRET"], optionalValueMode(config.resendWebhookSecret), false, "provider-delivery"),
    ]),
    integration("slack", "Slack", "platform", false, [
      checked("bot-auth", "Bot authentication", ["CHAT_SDK_SLACK_TOKEN"], slackBotMode, true),
      checked("channel", "Configured channel access", ["CHAT_SDK_SLACK_TOKEN", "CHAT_SDK_CHANNEL_ID"], slackChannelMode, true),
      checked("webhook-delivery", "Slash command signature", ["SLACK_SIGNING_SECRET", "SLACK_ALLOWED_USER_IDS"], optionalValueMode(config.slackSigningSecret), false, "local-observation"),
    ]),
    integration("arthur", "Arthur AI Engine", "platform", false, [
      checked("api", "Task API", ["GENAI_ENGINE_API_KEY", "GENAI_ENGINE_TRACE_ENDPOINT"], arthurMode, true),
    ]),
    integration("mcp", "Remote MCP", "platform", false, [
      checked("contract", "Published tool contract", ["MCP_ENABLED"], config.mcpEnabled ? "configured" : "not-configured", true),
    ]),
    integration("vercel", "Vercel deployment", "platform", false, [
      checked("project", "Project access", ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"], vercelMode, true),
      checked("production-deployment", "Production deployment", ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"], vercelMode, false),
    ]),
    integration("custom-webhooks", "Custom webhooks", "platform", false, [
      checked("aggregate", "Endpoint and delivery aggregate", ["WEBHOOK_TRIGGER_ENCRYPTION_KEY"], config.webhookTriggerEncryptionKey ? "configured" : "not-configured", false, "local-observation"),
    ]),
  ];
}

function integration(
  id: string,
  label: string,
  group: SystemHealthGroup,
  critical: boolean,
  checks: CheckBase[],
): IntegrationDefinition {
  return { id, label, group, critical, checks };
}

function configured(
  id: string,
  label: string,
  envVars: string[],
  value: unknown,
  explicitMode?: SystemHealthMode,
): CheckBase {
  const mode = explicitMode ?? (value ? "configured" : "misconfigured");
  return {
    id,
    label,
    description: "Required deployment configuration is present.",
    critical: true,
    mode,
    envVars,
    evidenceSource: "configuration",
    ...(mode === "misconfigured"
      ? { message: `${label} configuration is incomplete.` }
      : {}),
  };
}

function checked(
  id: string,
  label: string,
  envVars: string[],
  mode: SystemHealthMode,
  critical: boolean,
  evidenceSource: SystemHealthEvidenceSource = "live-probe",
): CheckBase {
  return {
    id,
    label,
    description: "Verified independently from other provider capabilities.",
    critical,
    mode,
    envVars,
    evidenceSource,
    ...(mode === "misconfigured"
      ? { message: `${label} configuration is incomplete.` }
      : {}),
  };
}

function fixed(
  id: string,
  label: string,
  mode: SystemHealthMode,
  critical: boolean,
  message: string,
): CheckBase {
  return {
    id,
    label,
    description: "Verified by the current protected request.",
    critical,
    mode,
    envVars: [],
    evidenceSource: "live-probe",
    message,
  };
}

async function probedCheck(
  base: CheckBase,
  probe: SystemHealthProbe | undefined,
  monotonicNow: () => number,
  checkedAt: string,
): Promise<SystemHealthCheck> {
  if (base.mode !== "configured") return base;
  // A configured check without a probe stays "configured": the value is present
  // and the scan makes no claim about it. Checks that cannot be probed are not
  // listed in the first place, so this is the OAuth-token agent case only.
  if (!probe) return base;

  const startedAt = monotonicNow();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      probe(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new PublicHealthProbeError("Health check timed out."));
        }, PROBE_TIMEOUT_MS);
      }),
    ]);
    const details = result ?? {};
    return {
      ...base,
      mode: details.mode ?? "live",
      checkedAt,
      latencyMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
      evidenceSource: details.evidenceSource ?? base.evidenceSource,
      ...(details.message ? { message: details.message } : {}),
      ...(details.observedAt ? { observedAt: details.observedAt } : {}),
      ...(details.coverage ? { coverage: details.coverage } : {}),
    };
  } catch (error) {
    return {
      ...base,
      mode: "down",
      checkedAt,
      latencyMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
      message:
        error instanceof PublicHealthProbeError
          ? error.message
          : "Health check failed.",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function integrationMode(checks: SystemHealthCheck[]): SystemHealthMode {
  if (checks.some((check) => check.critical && check.mode === "down")) return "down";
  if (checks.some((check) => check.critical && check.mode === "misconfigured")) {
    return "misconfigured";
  }
  if (
    checks.some(
      (check) =>
        !check.critical &&
        (check.mode === "down" || check.mode === "misconfigured"),
    )
  ) {
    return "degraded";
  }
  if (checks.some((check) => check.mode === "degraded")) return "degraded";
  if (checks.some((check) => check.mode === "live")) return "live";
  if (checks.every((check) => check.mode === "not-configured")) return "not-configured";
  if (checks.every((check) => check.mode === "mock")) return "mock";
  if (checks.some((check) => check.mode === "configured")) return "configured";
  return checks[0]?.mode ?? "not-configured";
}

function groupedMode(
  values: unknown[],
  emptyMode: Extract<SystemHealthMode, "not-configured" | "misconfigured" | "mock"> =
    "not-configured",
): SystemHealthMode {
  const count = values.filter(Boolean).length;
  if (count === 0) return emptyMode;
  return count === values.length ? "configured" : "misconfigured";
}

function requiredMode(values: unknown[]): SystemHealthMode {
  return values.every(Boolean) ? "configured" : "misconfigured";
}

function optionalValueMode(value: unknown): SystemHealthMode {
  return value ? "configured" : "not-configured";
}

function dependentOptionalMode(
  parentMode: SystemHealthMode,
  value: unknown,
): SystemHealthMode {
  if (parentMode === "not-configured") return "not-configured";
  if (parentMode === "misconfigured") return "misconfigured";
  return value ? "configured" : "misconfigured";
}

export class PublicHealthProbeError extends Error {}
