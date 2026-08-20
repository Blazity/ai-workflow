import { sql } from "drizzle-orm";
import type { SystemHealthResponse } from "@shared/contracts";
import { env } from "../../env.js";
import { JiraAdapter } from "../adapters/issue-tracker/jira.js";
import { getDb } from "../db/client.js";
import { buildOctokit } from "../lib/github-auth.js";
import { MCP_CONTRACT_ARTIFACT } from "../mcp/contract-artifact.js";
import {
  collectSystemHealth,
  PublicHealthProbeError,
  type SystemHealthConfig,
  type SystemHealthProbes,
} from "./collect.js";

export function collectDeploymentSystemHealth(): Promise<SystemHealthResponse> {
  const config = configFromEnvironment();
  return collectSystemHealth({
    config,
    probes: probesForEnvironment(config),
  });
}

export function configFromEnvironment(): SystemHealthConfig {
  return {
    databaseUrl: env.DATABASE_URL,
    jiraBaseUrl: env.JIRA_BASE_URL,
    jiraApiToken: env.JIRA_API_TOKEN,
    jiraProjectKey: env.JIRA_PROJECT_KEY,
    githubAppId: env.GITHUB_APP_ID,
    githubAppPrivateKey: env.GITHUB_APP_PRIVATE_KEY,
    githubInstallationId: env.GITHUB_INSTALLATION_ID,
    githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET,
    gitlabToken: env.GITLAB_TOKEN,
    gitlabHost: env.GITLAB_HOST,
    gitlabWebhookSecret: env.GITLAB_WEBHOOK_SECRET,
    agentKind: env.AGENT_KIND,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    anthropicModel: env.CLAUDE_MODEL,
    codexApiKey: env.CODEX_API_KEY,
    codexOauthToken: env.CODEX_CHATGPT_OAUTH_TOKEN,
    codexModel: env.CODEX_MODEL,
    betterAuthSecret: env.BETTER_AUTH_SECRET,
    betterAuthUrl: env.BETTER_AUTH_URL,
    dashboardOrigin: env.DASHBOARD_ORIGIN,
    ssoIssuer: env.SSO_ISSUER,
    ssoAllowedDomain: env.SSO_ALLOWED_DOMAIN,
    ssoClientId: env.SSO_CLIENT_ID,
    ssoClientSecret: env.SSO_CLIENT_SECRET,
    resendApiKey: env.RESEND_API_KEY,
    resendFromEmail: env.RESEND_FROM_EMAIL,
    resendWebhookSecret: env.RESEND_WEBHOOK_SECRET,
    slackToken: env.CHAT_SDK_SLACK_TOKEN,
    slackChannelId: env.CHAT_SDK_CHANNEL_ID,
    arthurApiKey: env.GENAI_ENGINE_API_KEY,
    arthurTraceEndpoint: env.GENAI_ENGINE_TRACE_ENDPOINT,
    mcpEnabled: env.MCP_ENABLED,
    vercelEnv: env.VERCEL_ENV,
    vercelToken: env.VERCEL_TOKEN,
    vercelTeamId: env.VERCEL_TEAM_ID,
    vercelProjectId: env.VERCEL_PROJECT_ID,
  };
}

export function probesForEnvironment(
  config: SystemHealthConfig,
): SystemHealthProbes {
  return {
    database: async () => {
      try {
        await getDb().execute(sql.raw("select 1"));
      } catch {
        throw new PublicHealthProbeError("Database did not respond.");
      }
    },
    jira: async (signal) => {
      if (!config.jiraBaseUrl || !config.jiraApiToken || !config.jiraProjectKey) return;
      try {
        const adapter = new JiraAdapter({
          baseUrl: config.jiraBaseUrl,
          apiToken: config.jiraApiToken,
          projectKey: config.jiraProjectKey,
        });
        await adapter.getCurrentUserAccountId(signal);
        await adapter.listStatuses(signal);
      } catch {
        throw new PublicHealthProbeError("Jira authentication check failed.");
      }
    },
    ...(config.githubAppId &&
    config.githubAppPrivateKey &&
    config.githubInstallationId
      ? {
          github: async (signal) => {
            try {
              await buildOctokit({
                appId: config.githubAppId!,
                privateKeyBase64: config.githubAppPrivateKey!,
                installationId: config.githubInstallationId!,
              }).apps.getInstallation({
                installation_id: config.githubInstallationId!,
                request: { signal },
              });
            } catch {
              throw new PublicHealthProbeError("GitHub App authentication failed.");
            }
          },
        }
      : {}),
    ...(config.gitlabToken
      ? {
          gitlab: async (signal) => {
            const response = await fetch(
              `${(config.gitlabHost ?? "https://gitlab.com").replace(/\/+$/, "")}/api/v4/user`,
              {
                headers: { "PRIVATE-TOKEN": config.gitlabToken! },
                signal,
              },
            ).catch(() => null);
            if (!response?.ok) {
              throw new PublicHealthProbeError("GitLab authentication failed.");
            }
          },
        }
      : {}),
    ...(config.ssoIssuer
      ? {
          sso: async (signal) => {
            const issuer = config.ssoIssuer!.replace(/\/+$/, "");
            const response = await fetch(
              `${issuer}/.well-known/openid-configuration`,
              { signal },
            ).catch(() => null);
            const metadata = response?.ok
              ? ((await response.json().catch(() => null)) as {
                  issuer?: unknown;
                } | null)
              : null;
            if (!metadata || metadata.issuer !== config.ssoIssuer) {
              throw new PublicHealthProbeError("SSO discovery check failed.");
            }
          },
        }
      : {}),
    ...(config.resendApiKey
      ? {
          email: async (signal) => {
            const response = await fetch("https://api.resend.com/domains", {
              headers: { Authorization: `Bearer ${config.resendApiKey}` },
              signal,
            }).catch(() => null);
            if (response?.ok) return;
            const error = response
              ? ((await response.json().catch(() => null)) as {
                  name?: unknown;
                } | null)
              : null;
            if (response?.status === 401 && error?.name === "restricted_api_key") {
              return;
            }
            throw new PublicHealthProbeError("Resend authentication failed.");
          },
        }
      : {}),
    ...(config.slackToken
      ? {
          slack: async (signal) => {
            const response = await fetch("https://slack.com/api/auth.test", {
              method: "POST",
              headers: { Authorization: `Bearer ${config.slackToken}` },
              signal,
            }).catch(() => null);
            const result = response?.ok
              ? ((await response.json().catch(() => null)) as {
                  ok?: unknown;
                } | null)
              : null;
            if (result?.ok !== true) {
              throw new PublicHealthProbeError("Slack authentication failed.");
            }
          },
        }
      : {}),
    ...(config.arthurApiKey && config.arthurTraceEndpoint
      ? {
          arthur: async (signal) => {
            const baseUrl = config.arthurTraceEndpoint!
              .replace(/\/api\/v1\/traces\/?$/, "")
              .replace(/\/+$/, "");
            const response = await fetch(`${baseUrl}/api/v2/tasks?page_size=1`, {
              headers: {
                Authorization: `Bearer ${config.arthurApiKey}`,
                "ngrok-skip-browser-warning": "true",
              },
              signal,
            }).catch(() => null);
            if (!response?.ok) {
              throw new PublicHealthProbeError("Arthur authentication failed.");
            }
          },
        }
      : {}),
    ...(config.mcpEnabled
      ? {
          mcp: async () => {
            if (MCP_CONTRACT_ARTIFACT.tools.length === 0) {
              throw new PublicHealthProbeError("MCP contract has no tools.");
            }
          },
        }
      : {}),
    ...(config.vercelToken && config.vercelTeamId && config.vercelProjectId
      ? {
          vercel: async (signal) => {
            const projectId = encodeURIComponent(config.vercelProjectId!);
            const teamId = encodeURIComponent(config.vercelTeamId!);
            const response = await fetch(
              `https://api.vercel.com/v9/projects/${projectId}?teamId=${teamId}`,
              {
                headers: { Authorization: `Bearer ${config.vercelToken}` },
                signal,
              },
            ).catch(() => null);
            if (!response?.ok) {
              throw new PublicHealthProbeError("Vercel project check failed.");
            }
          },
        }
      : {}),
    ...agentProbe(config),
  };
}

function agentProbe(
  config: SystemHealthConfig,
): Pick<SystemHealthProbes, "agent"> {
  if (
    config.agentKind === "claude" &&
    config.anthropicApiKey &&
    config.anthropicModel
  ) {
    // OAuth-style Claude credentials are consumed by the CLI, not the public
    // Models API. Presence is the honest readiness signal for that mode.
    if (config.anthropicApiKey.startsWith("sk-ant-oat")) return {};
    return {
      agent: async (signal) => {
        const response = await fetch("https://api.anthropic.com/v1/models", {
          headers: {
            "x-api-key": config.anthropicApiKey!,
            "anthropic-version": "2023-06-01",
          },
          signal,
        }).catch(() => null);
        if (!response?.ok) {
          throw new PublicHealthProbeError("Anthropic authentication failed.");
        }
        const body = (await response.json().catch(() => null)) as {
          data?: Array<{ id?: unknown }>;
        } | null;
        if (!body?.data?.some((model) => model.id === config.anthropicModel)) {
          throw new PublicHealthProbeError("Configured Claude model is unavailable.");
        }
      },
    };
  }
  if (config.agentKind === "codex" && config.codexApiKey && config.codexModel) {
    return {
      agent: async (signal) => {
        const response = await fetch(
          `https://api.openai.com/v1/models/${encodeURIComponent(config.codexModel!)}`,
          {
            headers: { Authorization: `Bearer ${config.codexApiKey}` },
            signal,
          },
        ).catch(() => null);
        if (!response?.ok) {
          throw new PublicHealthProbeError("OpenAI authentication failed.");
        }
      },
    };
  }
  return {};
}
