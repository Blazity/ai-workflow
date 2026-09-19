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
          mode: "configured",
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
      mode: "live",
      checks: expect.arrayContaining([
        expect.objectContaining({ id: "webhook-delivery", mode: "configured" }),
      ]),
    });
  });

  it("makes a broken required webhook visible on the provider", async () => {
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
      checks: expect.arrayContaining([
        expect.objectContaining({
          id: "webhook-delivery",
          mode: "down",
          message: expect.stringContaining("HTTP 401"),
        }),
      ]),
    });
    expect(result.summary.criticalDown).toBe(1);
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
    expect(result.summary.criticalDown).toBe(0);
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
  });

  it("keeps OAuth-backed agents configured, never live, when no safe probe exists", async () => {
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
      mode: "configured",
      checks: [expect.objectContaining({ id: "model", mode: "configured" })],
    });
  });

  it("lists only checks the scan can settle and never an unverified state", async () => {
    const result = await collectSystemHealth({
      config: {
        ...baseConfig,
        ssoIssuer: "https://sso.example",
        ssoClientId: "client",
        ssoClientSecret: "secret",
        ssoAllowedDomain: "example.com",
        mcpEnabled: true,
        webhookTriggerEncryptionKey: "k".repeat(64),
      },
      probes: {
        "database.connectivity": async () => {},
        "jira.api": async () => {},
        "jira.webhook-delivery": async () => ({ mode: "configured" }),
        "github.app-installation": async () => {},
        "github.repositories": async () => {},
        "github.webhook-delivery": async () => ({ mode: "live" }),
        "agent.model": async () => {},
        "sso.discovery": async () => {},
        "arthur.api": async () => {},
        "mcp.contract": async () => {},
        "custom-webhooks.aggregate": async () => ({ mode: "not-configured" }),
      },
    });

    const checks = result.integrations.flatMap((entry) =>
      entry.checks.map((check) => ({ id: `${entry.id}.${check.id}`, mode: check.mode })),
    );
    expect(checks.map((check) => check.id)).not.toEqual(
      expect.arrayContaining([
        "sso.login-start",
        "arthur.trace-ingestion",
        "mcp.authenticated-transport",
      ]),
    );
    expect(checks).toContainEqual({ id: "sso.client", mode: "configured" });
    expect(JSON.stringify(result)).not.toContain("unverified");
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

  it("appends contributed sections without touching a single core one", async () => {
    const probes = {
      "database.connectivity": async () => {},
      "jira.api": async () => {},
      "github.app-installation": async () => {},
      "agent.model": async () => {},
    };
    const now = () => new Date("2026-09-18T12:00:00.000Z");
    const monotonicNow = () => 0;
    const withoutIntegrations = await collectSystemHealth({
      config: baseConfig,
      probes,
      now,
      monotonicNow,
    });
    const withIntegrations = await collectSystemHealth({
      config: baseConfig,
      probes: { ...probes, "demo.auth": async () => ({ mode: "live" as const }) },
      now,
      monotonicNow,
      contributed: [
        {
          id: "demo",
          label: "Demo",
          group: "integrations",
          critical: false,
          description: "A provider used for tests.",
          checks: [
            {
              id: "auth",
              label: "Token accepted",
              description: "The provider accepts the token.",
              critical: true,
              mode: "configured",
              envVars: [],
              evidenceSource: "live-probe",
            },
          ],
        },
      ],
    });

    // The point of the stage: what core reports about core is untouched.
    expect(
      withIntegrations.integrations.filter((entry) => entry.group !== "integrations"),
    ).toEqual(withoutIntegrations.integrations);
    expect(
      withIntegrations.integrations.filter((entry) => entry.group === "integrations"),
    ).toEqual([
      expect.objectContaining({
        id: "demo",
        label: "Demo",
        description: "A provider used for tests.",
        critical: false,
        mode: "live",
      }),
    ]);
    expect(withIntegrations.summary.total).toBe(withoutIntegrations.summary.total + 1);
    expect(withIntegrations.summary.criticalDown).toBe(
      withoutIntegrations.summary.criticalDown,
    );
  });

  it("counts a disabled integration as neither down nor unconfigured", async () => {
    const result = await collectSystemHealth({
      config: baseConfig,
      probes: {},
      contributed: [
        {
          id: "demo",
          label: "Demo",
          group: "integrations",
          critical: false,
          checks: [
            // The first check is deliberately not the one that decides: a
            // section read from its first row alone would call this Not
            // configured and send somebody to set a variable.
            {
              id: "auth",
              label: "Token accepted",
              description: "The provider accepts the token.",
              critical: true,
              mode: "not-configured",
              envVars: [],
              evidenceSource: "live-probe",
            },
            {
              id: "connection",
              label: "Connection",
              description: "Where this integration's values come from.",
              critical: true,
              mode: "disabled",
              envVars: [],
              evidenceSource: "configuration",
              message: "Demo is turned off on the Integrations page.",
            },
          ],
        },
      ],
    });

    const before = await collectSystemHealth({ config: baseConfig, probes: {} });
    const demo = result.integrations.find((entry) => entry.id === "demo");
    expect(demo).toMatchObject({ mode: "disabled", ping: null });
    // A decision somebody made is not a state anybody has to chase, so it moves
    // none of the counters an operator reads first.
    expect(result.summary.down).toBe(before.summary.down);
    expect(result.summary.notConfigured).toBe(before.summary.notConfigured);
    expect(result.summary.criticalDown).toBe(before.summary.criticalDown);
  });

  it("never lets disabled swallow a check that is actually failing", async () => {
    const result = await collectSystemHealth({
      config: baseConfig,
      probes: {},
      contributed: [
        {
          id: "demo",
          label: "Demo",
          group: "integrations",
          critical: false,
          checks: [
            {
              id: "connection",
              label: "Connection",
              description: "Where this integration's values come from.",
              critical: true,
              mode: "disabled",
              envVars: [],
              evidenceSource: "configuration",
              message: "Demo is turned off on the Integrations page.",
            },
            {
              id: "auth",
              label: "Token accepted",
              description: "The provider accepts the token.",
              critical: true,
              mode: "down",
              envVars: [],
              evidenceSource: "live-probe",
              message: "The provider refused the credential.",
            },
          ],
        },
      ],
    });

    expect(result.integrations.find((entry) => entry.id === "demo")).toMatchObject({
      mode: "down",
    });
  });

  it("bounds ten hanging integrations by the one probe timeout, not by their number", async () => {
    vi.useFakeTimers();
    const contributed = Array.from({ length: 10 }, (_, index) => ({
      id: `demo-${index}`,
      label: `Demo ${index}`,
      group: "integrations" as const,
      critical: false,
      checks: [
        {
          id: "auth",
          label: "Token accepted",
          description: "The provider accepts the token.",
          critical: true,
          mode: "configured" as const,
          envVars: [],
          evidenceSource: "live-probe" as const,
        },
      ],
    }));
    const probes = Object.fromEntries(
      contributed.map((definition) => [
        `${definition.id}.auth`,
        async () => {
          await new Promise(() => {});
        },
      ]),
    );

    const pending = collectSystemHealth({ config: baseConfig, probes, contributed });
    // One window, not ten: a scan the dashboard aborts after 15 s cannot afford
    // to run provider probes one after another.
    await vi.advanceTimersByTimeAsync(4_000);
    const result = await pending;

    const sections = result.integrations.filter((entry) => entry.group === "integrations");
    expect(sections).toHaveLength(10);
    for (const section of sections) {
      expect(section.checks[0]).toMatchObject({
        mode: "down",
        message: "Health check timed out.",
      });
    }
    // A provider that hangs is not the platform going down.
    expect(result.summary.criticalDown).toBe(0);
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
