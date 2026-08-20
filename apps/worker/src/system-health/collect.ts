import type {
  SystemHealthAlert,
  SystemHealthIntegration,
  SystemHealthMode,
  SystemHealthResponse,
} from "@shared/contracts";

export type SystemHealthConfig = {
  databaseUrl?: string;
  jiraBaseUrl?: string;
  jiraApiToken?: string;
  jiraProjectKey?: string;
  githubAppId?: number;
  githubAppPrivateKey?: string;
  githubInstallationId?: number;
  githubWebhookSecret?: string;
  gitlabToken?: string;
  gitlabHost?: string;
  gitlabWebhookSecret?: string;
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
  arthurApiKey?: string;
  arthurTraceEndpoint?: string;
  mcpEnabled: boolean;
  vercelEnv?: string;
  vercelToken?: string;
  vercelTeamId?: string;
  vercelProjectId?: string;
};

export type SystemHealthProbeId =
  | "database"
  | "jira"
  | "github"
  | "gitlab"
  | "agent"
  | "sso"
  | "email"
  | "slack"
  | "arthur"
  | "mcp"
  | "vercel";

export type SystemHealthProbes = Partial<
  Record<SystemHealthProbeId, (signal: AbortSignal) => Promise<void>>
>;

const PROBE_TIMEOUT_MS = 5_000;

export async function collectSystemHealth(input: {
  config: SystemHealthConfig;
  probes: SystemHealthProbes;
  now?: () => Date;
  monotonicNow?: () => number;
}): Promise<SystemHealthResponse> {
  const now = input.now ?? (() => new Date());
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  const { config, probes } = input;

  const githubMode = groupedMode([
    config.githubAppId,
    config.githubAppPrivateKey,
    config.githubInstallationId,
    config.githubWebhookSecret,
  ]);
  const gitlabMode = groupedMode([
    config.gitlabToken,
    config.gitlabWebhookSecret,
  ]);
  const jiraMode: SystemHealthMode =
    config.jiraBaseUrl && config.jiraApiToken && config.jiraProjectKey
      ? "configured"
      : "misconfigured";
  const ssoMode = groupedMode([
    config.ssoIssuer,
    config.ssoAllowedDomain,
    config.ssoClientId,
    config.ssoClientSecret,
  ]);
  const emailBaseMode = groupedMode([config.resendApiKey, config.resendFromEmail]);
  const emailMode: SystemHealthMode =
    config.resendWebhookSecret && emailBaseMode !== "configured"
      ? "misconfigured"
      : emailBaseMode;
  const slackMode = groupedMode([config.slackToken, config.slackChannelId], "mock");
  const arthurMode = groupedMode([
    config.arthurApiKey,
    config.arthurTraceEndpoint,
  ]);
  const authMode = groupedMode([
    config.betterAuthSecret,
    config.betterAuthUrl,
    config.dashboardOrigin,
  ], "misconfigured");
  const vercelCredentials = groupedMode([
    config.vercelToken,
    config.vercelTeamId,
    config.vercelProjectId,
  ]);
  const vercelMode: SystemHealthMode = config.vercelEnv
    ? "configured"
    : vercelCredentials;
  const agentConfigured =
    config.agentKind === "claude"
      ? Boolean(config.anthropicApiKey && config.anthropicModel)
      : Boolean((config.codexApiKey || config.codexOauthToken) && config.codexModel);

  const integrations = await Promise.all([
    probedIntegration(
      {
        id: "database",
        label: "Database",
        group: "core",
        envVars: ["DATABASE_URL"],
        critical: true,
        mode: config.databaseUrl ? "configured" : "misconfigured",
        configError: config.databaseUrl ? undefined : "DATABASE_URL is missing.",
      },
      probes.database,
      monotonicNow,
    ),
    probedIntegration(
      {
        id: "jira",
        label: "Jira",
        group: "core",
        envVars: ["JIRA_BASE_URL", "JIRA_API_TOKEN", "JIRA_PROJECT_KEY"],
        critical: true,
        mode: jiraMode,
        configError:
          jiraMode === "configured"
            ? undefined
            : "Jira URL, API token, and project key are required.",
      },
      probes.jira,
      monotonicNow,
    ),
    probedIntegration(
      {
        id: "github",
        label: "GitHub",
        group: "core",
        envVars: [
          "GITHUB_APP_ID",
          "GITHUB_APP_PRIVATE_KEY",
          "GITHUB_INSTALLATION_ID",
          "GITHUB_WEBHOOK_SECRET",
        ],
        critical: true,
        mode: githubMode,
        configError:
          githubMode === "misconfigured"
            ? "GitHub App credentials and webhook secret must be configured together."
            : undefined,
      },
      probes.github,
      monotonicNow,
    ),
    probedIntegration(
      {
        id: "gitlab",
        label: "GitLab",
        group: "core",
        envVars: ["GITLAB_TOKEN", "GITLAB_HOST", "GITLAB_WEBHOOK_SECRET"],
        critical: true,
        mode: gitlabMode,
        configError:
          gitlabMode === "misconfigured"
            ? "GitLab token and webhook secret must be configured together."
            : undefined,
      },
      probes.gitlab,
      monotonicNow,
    ),
    probedIntegration(
      {
        id: "agent",
        label: config.agentKind === "claude" ? "Claude agent" : "Codex agent",
        group: "core",
        envVars:
          config.agentKind === "claude"
            ? ["AGENT_KIND", "ANTHROPIC_API_KEY", "CLAUDE_MODEL"]
            : ["AGENT_KIND", "CODEX_API_KEY", "CODEX_CHATGPT_OAUTH_TOKEN", "CODEX_MODEL"],
        critical: true,
        mode: agentConfigured ? "configured" : "misconfigured",
        configError: agentConfigured
          ? undefined
          : `Credentials and a model are required for the active ${config.agentKind} agent.`,
      },
      probes.agent,
      monotonicNow,
    ),
    Promise.resolve(
      configuredIntegration({
        id: "dashboard-auth",
        label: "Dashboard authentication",
        group: "auth-email",
        envVars: ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "DASHBOARD_ORIGIN"],
        critical: true,
        mode: authMode,
        configError:
          authMode === "misconfigured"
            ? "Dashboard authentication settings are incomplete."
            : undefined,
      }),
    ),
    probedIntegration(
      {
        id: "sso",
        label: "Single sign-on",
        group: "auth-email",
        envVars: [
          "SSO_ISSUER",
          "SSO_ALLOWED_DOMAIN",
          "SSO_CLIENT_ID",
          "SSO_CLIENT_SECRET",
        ],
        critical: false,
        mode: ssoMode,
        configError:
          ssoMode === "misconfigured"
            ? "SSO requires issuer, domain, client ID, and client secret together."
            : undefined,
      },
      probes.sso,
      monotonicNow,
    ),
    probedIntegration(
      {
        id: "email",
        label: "Email delivery",
        group: "auth-email",
        envVars: ["RESEND_API_KEY", "RESEND_FROM_EMAIL", "RESEND_WEBHOOK_SECRET"],
        critical: false,
        mode: emailMode,
        configError:
          emailMode === "misconfigured"
            ? "Email delivery requires RESEND_API_KEY and RESEND_FROM_EMAIL together."
            : undefined,
      },
      probes.email,
      monotonicNow,
    ),
    probedIntegration(
      {
        id: "slack",
        label: "Slack notifications",
        group: "platform",
        envVars: ["CHAT_SDK_SLACK_TOKEN", "CHAT_SDK_CHANNEL_ID"],
        critical: false,
        mode: slackMode,
        configError:
          slackMode === "misconfigured"
            ? "Slack requires a token and channel ID together."
            : undefined,
      },
      probes.slack,
      monotonicNow,
    ),
    probedIntegration(
      {
        id: "arthur",
        label: "Arthur AI Engine",
        group: "platform",
        envVars: ["GENAI_ENGINE_API_KEY", "GENAI_ENGINE_TRACE_ENDPOINT"],
        critical: false,
        mode: arthurMode,
        configError:
          arthurMode === "misconfigured"
            ? "Arthur requires an API key and trace endpoint together."
            : undefined,
      },
      probes.arthur,
      monotonicNow,
    ),
    probedIntegration(
      {
        id: "mcp",
        label: "Remote MCP",
        group: "platform",
        envVars: ["MCP_ENABLED"],
        critical: false,
        mode: config.mcpEnabled ? "configured" : "not-configured",
      },
      probes.mcp,
      monotonicNow,
    ),
    probedIntegration(
      {
        id: "vercel",
        label: "Vercel deployment",
        group: "platform",
        envVars: ["VERCEL_ENV", "VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"],
        critical: false,
        mode: vercelMode,
        configError:
          vercelMode === "misconfigured"
            ? "Vercel credentials require token, team ID, and project ID together."
            : undefined,
      },
      probes.vercel,
      monotonicNow,
    ),
  ]);

  const alerts = integrations.flatMap(alertForIntegration);
  return {
    generatedAt: now().toISOString(),
    summary: {
      total: integrations.length,
      live: integrations.filter((entry) => entry.mode === "live").length,
      down: integrations.filter((entry) => entry.mode === "down").length,
      notConfigured: integrations.filter(
        (entry) => entry.mode === "not-configured",
      ).length,
      criticalDown: integrations.filter(
        (entry) => entry.mode === "down" && entry.critical,
      ).length,
    },
    integrations,
    alerts,
  };
}

type IntegrationBase = Omit<SystemHealthIntegration, "ping">;

function configuredIntegration(base: IntegrationBase): SystemHealthIntegration {
  return { ...base, ping: null };
}

async function probedIntegration(
  base: IntegrationBase,
  probe: ((signal: AbortSignal) => Promise<void>) | undefined,
  monotonicNow: () => number,
): Promise<SystemHealthIntegration> {
  if (base.mode !== "configured" || !probe) return configuredIntegration(base);
  const startedAt = monotonicNow();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      probe(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new PublicHealthProbeError("Health check timed out."));
        }, PROBE_TIMEOUT_MS);
      }),
    ]);
    return {
      ...base,
      mode: "live",
      ping: {
        ok: true,
        latencyMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
      },
    };
  } catch (error) {
    return {
      ...base,
      mode: "down",
      ping: {
        ok: false,
        latencyMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
        error:
          error instanceof PublicHealthProbeError
            ? error.message
            : "Health check failed.",
      },
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function groupedMode(
  values: unknown[],
  emptyMode: Extract<SystemHealthMode, "not-configured" | "misconfigured" | "mock"> =
    "not-configured",
): SystemHealthMode {
  const configured = values.filter(Boolean).length;
  if (configured === 0) return emptyMode;
  return configured === values.length ? "configured" : "misconfigured";
}

function alertForIntegration(
  integration: SystemHealthIntegration,
): SystemHealthAlert[] {
  if (integration.mode !== "down" && integration.mode !== "misconfigured") {
    return [];
  }
  const severity = integration.critical ? "critical" : "warning";
  const detail =
    integration.mode === "down"
      ? integration.ping?.error ?? "Health check failed."
      : integration.configError ?? "Configuration is incomplete.";
  return [
    {
      severity,
      integrationId: integration.id,
      message: `${integration.label}: ${detail}`,
      fixHint: `Check ${integration.envVars.join(", ")} and the provider setup.`,
    },
  ];
}

export class PublicHealthProbeError extends Error {}
