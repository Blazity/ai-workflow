import { afterEach, describe, expect, it, vi } from "vitest";
import { collectSystemHealth, type SystemHealthConfig } from "./collect.js";

const baseConfig: SystemHealthConfig = {
  databaseUrl: "postgres://fixture/db",
  agentKind: "claude",
  anthropicApiKey: "anthropic-secret",
  anthropicModel: "claude-test",
  betterAuthSecret: "auth-secret",
  betterAuthUrl: "https://worker.example",
  dashboardOrigin: "https://dashboard.example",
  mcpEnabled: false,
};

describe("collectSystemHealth", () => {
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

  it("does not let an inbound-only webhook make Email look live", async () => {
    const result = await collectSystemHealth({
      config: {
        ...baseConfig,
        resendWebhookSecret: "orphaned-resend-secret",
      },
      probes: {
        "email.webhook-delivery": async () => ({ mode: "live" }),
      },
    });

    expect(result.integrations.find((entry) => entry.id === "email")).toMatchObject({
      mode: "misconfigured",
    });
  });

  it("still probes SSO discovery with partial setup", async () => {
    const ssoDiscovery = vi.fn(async () => {});
    const result = await collectSystemHealth({
      config: {
        ...baseConfig,
        ssoIssuer: "https://sso.example",
      },
      probes: {
        "sso.discovery": ssoDiscovery,
      },
    });

    expect(ssoDiscovery).toHaveBeenCalledOnce();
    expect(
      result.integrations
        .find((entry) => entry.id === "sso")
        ?.checks.find((check) => check.id === "discovery"),
    ).toMatchObject({ mode: "live" });
  });

  it("no longer knows Jira or Slack, whose variables are named by their own integration now", async () => {
    const result = await collectSystemHealth({ config: baseConfig, probes: {} });
    // Jira's health section moved to its own integration
    // (`integrations/jira/manifest.ts`), the same way Slack's did
    // (`integrations/slack/manifest.ts`); core no longer lists either.
    expect(result.integrations.map((entry) => entry.id)).not.toContain("jira");
    expect(result.integrations.map((entry) => entry.id)).not.toContain("slack");
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
