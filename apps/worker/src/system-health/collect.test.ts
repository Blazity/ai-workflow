import { afterEach, describe, expect, it, vi } from "vitest";
import { collectSystemHealth, type SystemHealthConfig } from "./collect.js";

const baseConfig: SystemHealthConfig = {
  databaseUrl: "postgres://fixture/db",
  jiraBaseUrl: "https://jira.example",
  jiraApiToken: "jira-secret",
  jiraProjectKey: "TEST",
  githubAppId: 1,
  githubAppPrivateKey: "private-key",
  githubInstallationId: 2,
  githubWebhookSecret: "webhook-secret",
  agentKind: "claude",
  anthropicApiKey: "anthropic-secret",
  anthropicModel: "claude-test",
  betterAuthSecret: "auth-secret",
  betterAuthUrl: "https://worker.example",
  dashboardOrigin: "https://dashboard.example",
  mcpEnabled: false,
};

function clock(...values: number[]) {
  let index = 0;
  return () => values[index++] ?? values.at(-1) ?? 0;
}

describe("collectSystemHealth", () => {
  it("reports live critical probes and neutral optional integrations", async () => {
    const result = await collectSystemHealth({
      config: baseConfig,
      probes: {
        database: async () => {},
        jira: async () => {},
        github: async () => {},
        agent: async () => {},
      },
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      monotonicNow: clock(0, 0, 0, 0, 12, 25, 40, 58),
    });

    expect(result.generatedAt).toBe("2026-08-20T12:00:00.000Z");
    expect(result.summary).toMatchObject({
      total: 12,
      live: 4,
      down: 0,
      criticalDown: 0,
    });
    expect(result.integrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "database", mode: "live" }),
        expect.objectContaining({ id: "github", mode: "live" }),
        expect.objectContaining({ id: "gitlab", mode: "not-configured" }),
        expect.objectContaining({ id: "slack", mode: "mock" }),
      ]),
    );
    expect(result.alerts).toEqual([]);
  });

  it("turns failed probes and partial optional configuration into actionable alerts", async () => {
    const result = await collectSystemHealth({
      config: {
        ...baseConfig,
        slackToken: "slack-secret",
        ssoIssuer: "https://sso.example",
      },
      probes: {
        database: async () => {
          throw new Error("postgres://user:password@secret-host/db");
        },
        jira: async () => {},
        github: async () => {},
        agent: async () => {},
      },
      monotonicNow: clock(0, 0, 0, 0, 5, 10, 15, 20),
    });

    expect(result.summary).toMatchObject({ down: 1, criticalDown: 1 });
    expect(result.integrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "database",
          mode: "down",
          ping: expect.objectContaining({ error: "Health check failed." }),
        }),
        expect.objectContaining({ id: "slack", mode: "misconfigured" }),
        expect.objectContaining({ id: "sso", mode: "misconfigured" }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("secret-host");
    expect(result.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "critical",
          integrationId: "database",
          fixHint: expect.stringContaining("DATABASE_URL"),
        }),
        expect.objectContaining({ severity: "warning", integrationId: "slack" }),
      ]),
    );
  });

  it("keeps OAuth-backed agents honest as configured when no safe ping exists", async () => {
    const result = await collectSystemHealth({
      config: {
        ...baseConfig,
        agentKind: "codex",
        anthropicApiKey: undefined,
        codexOauthToken: "oauth-secret",
        codexModel: "gpt-test",
      },
      probes: {
        database: async () => {},
        jira: async () => {},
        github: async () => {},
      },
    });

    expect(result.integrations).toContainEqual(
      expect.objectContaining({
        id: "agent",
        label: "Codex agent",
        mode: "configured",
        ping: null,
      }),
    );
  });

  it("classifies every empty and partial configuration without claiming connectivity", async () => {
    const empty = await collectSystemHealth({
      config: { agentKind: "claude", mcpEnabled: false },
      probes: {},
    });
    const modes = Object.fromEntries(
      empty.integrations.map((integration) => [integration.id, integration.mode]),
    );
    expect(modes).toEqual({
      database: "misconfigured",
      jira: "misconfigured",
      github: "not-configured",
      gitlab: "not-configured",
      agent: "misconfigured",
      "dashboard-auth": "misconfigured",
      sso: "not-configured",
      email: "not-configured",
      slack: "mock",
      arthur: "not-configured",
      mcp: "not-configured",
      vercel: "not-configured",
    });

    const partialCases: Array<[string, Partial<SystemHealthConfig>, string]> = [
      ["jira", { jiraBaseUrl: "https://jira.example", jiraApiToken: "token" }, "misconfigured"],
      ["github", { githubAppId: 1, githubAppPrivateKey: "key", githubInstallationId: 2 }, "misconfigured"],
      ["gitlab", { gitlabToken: "token" }, "misconfigured"],
      ["dashboard-auth", { betterAuthSecret: "secret" }, "misconfigured"],
      ["sso", { ssoIssuer: "https://sso.example" }, "misconfigured"],
      ["email", { resendApiKey: "key" }, "misconfigured"],
      ["email", { resendWebhookSecret: "webhook" }, "misconfigured"],
      ["slack", { slackToken: "token" }, "misconfigured"],
      ["arthur", { arthurApiKey: "key" }, "misconfigured"],
      ["vercel", { vercelToken: "token", vercelTeamId: "team" }, "misconfigured"],
    ];

    for (const [id, patch, expected] of partialCases) {
      const result = await collectSystemHealth({
        config: { agentKind: "claude", mcpEnabled: false, ...patch },
        probes: {},
      });
      expect(result.integrations.find((entry) => entry.id === id)?.mode, id).toBe(expected);
    }
  });

  it("exposes the exact variable names used to determine each integration", async () => {
    const result = await collectSystemHealth({ config: baseConfig, probes: {} });
    expect(Object.fromEntries(
      result.integrations.map((integration) => [integration.id, integration.envVars]),
    )).toEqual({
      database: ["DATABASE_URL"],
      jira: ["JIRA_BASE_URL", "JIRA_API_TOKEN", "JIRA_PROJECT_KEY"],
      github: ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_INSTALLATION_ID", "GITHUB_WEBHOOK_SECRET"],
      gitlab: ["GITLAB_TOKEN", "GITLAB_HOST", "GITLAB_WEBHOOK_SECRET"],
      agent: ["AGENT_KIND", "ANTHROPIC_API_KEY", "CLAUDE_MODEL"],
      "dashboard-auth": ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "DASHBOARD_ORIGIN"],
      sso: ["SSO_ISSUER", "SSO_ALLOWED_DOMAIN", "SSO_CLIENT_ID", "SSO_CLIENT_SECRET"],
      email: ["RESEND_API_KEY", "RESEND_FROM_EMAIL", "RESEND_WEBHOOK_SECRET"],
      slack: ["CHAT_SDK_SLACK_TOKEN", "CHAT_SDK_CHANNEL_ID"],
      arthur: ["GENAI_ENGINE_API_KEY", "GENAI_ENGINE_TRACE_ENDPOINT"],
      mcp: ["MCP_ENABLED"],
      vercel: ["VERCEL_ENV", "VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"],
    });
  });

  it("aborts a probe at the bounded timeout", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const pending = collectSystemHealth({
      config: { ...baseConfig },
      probes: {
        database: async (probeSignal) => {
          signal = probeSignal;
          await new Promise(() => {});
        },
      },
    });

    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(signal?.aborted).toBe(true);
    expect(result.integrations).toContainEqual(
      expect.objectContaining({
        id: "database",
        mode: "down",
        ping: expect.objectContaining({ error: "Health check timed out." }),
      }),
    );
  });
});

afterEach(() => {
  vi.useRealTimers();
});
