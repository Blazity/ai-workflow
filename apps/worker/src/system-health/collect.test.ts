import { afterEach, describe, expect, it, vi } from "vitest";
import { collectSystemHealth, type SystemHealthConfig } from "./collect.js";

const baseConfig: SystemHealthConfig = {
  databaseUrl: "postgres://fixture/db",
  jiraBaseUrl: "https://jira.example",
  jiraApiToken: "jira-secret",
  jiraProjectKey: "TEST",
  jiraWebhookSecret: "jira-webhook",
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

describe("collectSystemHealth", () => {
  it("keeps provider capabilities separate and aggregates only their real states", async () => {
    const result = await collectSystemHealth({
      config: baseConfig,
      probes: {
        "database.connectivity": async () => {},
        "jira.api": async () => {},
        "jira.webhook-delivery": async () => ({
          mode: "unverified",
          message: "No recent delivery.",
        }),
        "github.app-installation": async () => {},
        "github.repositories": async () => ({ coverage: { checked: 1, total: 2 } }),
        "github.webhook-delivery": async () => ({
          mode: "live",
          observedAt: "2026-08-20T11:59:00.000Z",
          evidenceSource: "provider-delivery",
        }),
        "agent.model": async () => {},
      },
      now: () => new Date("2026-08-20T12:00:00.000Z"),
    });

    const github = result.integrations.find((entry) => entry.id === "github");
    expect(github).toMatchObject({ mode: "live" });
    expect(github?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "app-installation", mode: "live" }),
        expect.objectContaining({
          id: "repositories",
          mode: "live",
          coverage: { checked: 1, total: 2 },
        }),
        expect.objectContaining({
          id: "webhook-delivery",
          mode: "live",
          evidenceSource: "provider-delivery",
        }),
      ]),
    );
    expect(result.integrations.find((entry) => entry.id === "jira")).toMatchObject({
      mode: "unverified",
    });
    expect(result.summary.checksUnverified).toBeGreaterThan(0);
  });

  it("makes a broken required webhook visible on the provider and its alert", async () => {
    const result = await collectSystemHealth({
      config: baseConfig,
      probes: {
        "database.connectivity": async () => {},
        "jira.api": async () => {},
        "jira.webhook-delivery": async () => ({ mode: "live" }),
        "github.app-installation": async () => {},
        "github.repositories": async () => {},
        "github.webhook-delivery": async () => ({
          mode: "down",
          message: "Latest delivery failed with HTTP 401.",
        }),
        "agent.model": async () => {},
      },
    });

    expect(result.integrations.find((entry) => entry.id === "github")).toMatchObject({
      mode: "down",
    });
    expect(result.alerts).toContainEqual(
      expect.objectContaining({
        severity: "critical",
        integrationId: "github",
        checkId: "webhook-delivery",
        message: expect.stringContaining("HTTP 401"),
      }),
    );
  });

  it("uses degraded for an optional failure without hiding healthy required checks", async () => {
    const result = await collectSystemHealth({
      config: {
        ...baseConfig,
        resendApiKey: "resend-key",
        resendFromEmail: "System <system@example.com>",
        resendWebhookSecret: "resend-webhook",
      },
      probes: {
        "email.sender": async () => {},
        "email.webhook-delivery": async () => ({
          mode: "down",
          message: "Latest webhook signature was rejected.",
        }),
      },
    });
    expect(result.integrations.find((entry) => entry.id === "email")).toMatchObject({
      mode: "degraded",
    });
    expect(result.alerts).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        integrationId: "email",
        checkId: "webhook-delivery",
      }),
    );
  });

  it("surfaces untrusted rejection evidence as a warning, not a hard outage", async () => {
    const result = await collectSystemHealth({
      config: baseConfig,
      probes: {
        "jira.api": async () => {},
        "jira.webhook-delivery": async () => ({
          mode: "degraded",
          message: "A recent request was rejected.",
        }),
      },
    });

    expect(
      result.integrations
        .find((entry) => entry.id === "jira")
        ?.checks.find((check) => check.id === "webhook-delivery"),
    ).toMatchObject({ mode: "degraded" });
    expect(result.integrations.find((entry) => entry.id === "jira")).toMatchObject({
      mode: "degraded",
    });
    expect(result.alerts).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        integrationId: "jira",
        checkId: "webhook-delivery",
      }),
    );
  });

  it("keeps OAuth-backed agents unverified when no safe provider probe exists", async () => {
    const result = await collectSystemHealth({
      config: {
        ...baseConfig,
        agentKind: "codex",
        anthropicApiKey: undefined,
        codexOauthToken: "oauth-secret",
        codexModel: "gpt-test",
      },
      probes: {},
    });
    expect(result.integrations.find((entry) => entry.id === "agent")).toMatchObject({
      mode: "unverified",
      checks: [expect.objectContaining({ id: "model", mode: "unverified" })],
    });
  });

  it("does not treat the default GitLab host as an enabled integration", async () => {
    const result = await collectSystemHealth({
      config: {
        ...baseConfig,
        gitlabHost: "https://gitlab.com",
      },
      probes: {},
    });
    expect(result.integrations.find((entry) => entry.id === "gitlab")).toMatchObject({
      mode: "not-configured",
    });
  });

  it("reports orphaned webhook secrets without provider credentials", async () => {
    const result = await collectSystemHealth({
      config: {
        ...baseConfig,
        githubAppId: undefined,
        githubAppPrivateKey: undefined,
        githubInstallationId: undefined,
        githubWebhookSecret: "orphaned-secret",
      },
      probes: {},
    });
    expect(result.integrations.find((entry) => entry.id === "github")).toMatchObject({
      mode: "misconfigured",
    });
  });

  it("does not let an inbound-only webhook make Email or Slack look live", async () => {
    const result = await collectSystemHealth({
      config: {
        ...baseConfig,
        resendWebhookSecret: "orphaned-resend-secret",
        slackSigningSecret: "orphaned-slack-secret",
      },
      probes: {
        "email.webhook-delivery": async () => ({ mode: "live" }),
        "slack.webhook-delivery": async () => ({ mode: "live" }),
      },
    });

    for (const integrationId of ["email", "slack"]) {
      expect(
        result.integrations.find((entry) => entry.id === integrationId),
      ).toMatchObject({ mode: "misconfigured" });
      expect(result.alerts).toContainEqual(
        expect.objectContaining({
          severity: "warning",
          integrationId,
        }),
      );
    }
  });

  it("still probes independent Slack auth and SSO discovery with partial setup", async () => {
    const slackAuth = vi.fn(async () => {});
    const ssoDiscovery = vi.fn(async () => {});
    const result = await collectSystemHealth({
      config: {
        ...baseConfig,
        slackToken: "slack-token",
        ssoIssuer: "https://sso.example",
      },
      probes: {
        "slack.bot-auth": slackAuth,
        "sso.discovery": ssoDiscovery,
      },
    });

    expect(slackAuth).toHaveBeenCalledOnce();
    expect(ssoDiscovery).toHaveBeenCalledOnce();
    expect(
      result.integrations
        .find((entry) => entry.id === "slack")
        ?.checks.find((check) => check.id === "bot-auth"),
    ).toMatchObject({ mode: "live" });
    expect(
      result.integrations
        .find((entry) => entry.id === "sso")
        ?.checks.find((check) => check.id === "discovery"),
    ).toMatchObject({ mode: "live" });
  });

  it("exposes every capability variable name without values", async () => {
    const result = await collectSystemHealth({ config: baseConfig, probes: {} });
    expect(result.integrations.find((entry) => entry.id === "jira")?.envVars).toEqual([
      "JIRA_BASE_URL",
      "JIRA_API_TOKEN",
      "JIRA_PROJECT_KEY",
      "JIRA_WEBHOOK_SECRET",
    ]);
    expect(result.integrations.find((entry) => entry.id === "slack")?.envVars).toEqual([
      "CHAT_SDK_SLACK_TOKEN",
      "CHAT_SDK_CHANNEL_ID",
      "SLACK_SIGNING_SECRET",
      "SLACK_ALLOWED_USER_IDS",
    ]);
    expect(JSON.stringify(result)).not.toContain("jira-secret");
  });

  it("aborts only the timed-out capability and marks it down", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const pending = collectSystemHealth({
      config: baseConfig,
      probes: {
        "database.connectivity": async (probeSignal) => {
          signal = probeSignal;
          await new Promise(() => {});
        },
      },
    });
    await vi.advanceTimersByTimeAsync(4_000);
    const result = await pending;
    expect(signal?.aborted).toBe(true);
    expect(
      result.integrations
        .find((entry) => entry.id === "database")
        ?.checks.find((check) => check.id === "connectivity"),
    ).toMatchObject({ mode: "down", message: "Health check timed out." });
  });
});

afterEach(() => {
  vi.useRealTimers();
});
