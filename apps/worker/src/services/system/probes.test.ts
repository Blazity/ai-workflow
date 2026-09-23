import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemHealthConfig } from "./collect.js";

const environment = vi.hoisted(() => ({
  DATABASE_URL: "postgres://db.example/workflow",
  GITHUB_APP_ID: 11,
  GITHUB_APP_PRIVATE_KEY: "github-key",
  GITHUB_INSTALLATION_ID: 22,
  GITHUB_WEBHOOK_SECRET: "github-webhook",
  GITLAB_TOKEN: "gitlab-token",
  GITLAB_HOST: "https://gitlab.example",
  GITLAB_WEBHOOK_SECRET: "gitlab-webhook",
  GITLAB_PROJECT_ID: "group/project",
  ANTHROPIC_API_KEY: "anthropic-key",
  CODEX_API_KEY: "openai-key",
  CODEX_CHATGPT_OAUTH_TOKEN: "codex-oauth",
  BETTER_AUTH_SECRET: "auth-secret",
  BETTER_AUTH_URL: "https://worker.example",
  DASHBOARD_ORIGIN: "https://dashboard.example",
  SSO_ISSUER: "https://sso.example",
  SSO_ALLOWED_DOMAIN: "example.com",
  SSO_CLIENT_ID: "sso-client",
  SSO_CLIENT_SECRET: "sso-secret",
  RESEND_API_KEY: "resend-key",
  RESEND_FROM_EMAIL: "AI Workflow <system@example.com>",
  RESEND_WEBHOOK_SECRET: "resend-webhook",
  CHAT_SDK_SLACK_TOKEN: "slack-token",
  CHAT_SDK_CHANNEL_ID: "C123",
  SLACK_SIGNING_SECRET: "slack-signing",
  SLACK_ALLOWED_USER_IDS: "U1,U2",
  MCP_ENABLED: true,
  WEBHOOK_TRIGGER_ENCRYPTION_KEY: "a".repeat(64),
}));

vi.mock("../../infra/vcs-config.js", () => ({ env: environment }));
const latestWebhookDeliveries = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock("../../db/client.js", () => ({ getDb: () => ({}) }));
vi.mock("./observations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./observations.js")>()),
  latestWebhookDeliveries,
}));
vi.mock("../../mcp/contract-artifact.js", () => ({
  MCP_CONTRACT_ARTIFACT: {
    contractHash: "hash",
    tools: [{ name: "system.capabilities" }],
  },
}));

const { configFromEnvironment, probesForEnvironment } = await import("./probes.js");
const { settingsSnapshotFromEnvironment } = await import("../settings/snapshot.js");
// Ordinary values arrive from stored rows. Only the redeploy-owned settings
// below still consult the mocked deployment environment.
const settings = {
  ...settingsSnapshotFromEnvironment(),
  MCP_ENABLED: environment.MCP_ENABLED,
};
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

describe("deployment system-health probes", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    latestWebhookDeliveries.mockReset().mockResolvedValue([]);
  });

  it("maps credentials for every independently checked capability", () => {
    expect(configFromEnvironment(settings)).toEqual({
      databaseUrl: environment.DATABASE_URL,
      agentKind: "codex",
      anthropicApiKey: environment.ANTHROPIC_API_KEY,
      anthropicModel: "claude-opus-4-8",
      codexApiKey: environment.CODEX_API_KEY,
      codexOauthToken: environment.CODEX_CHATGPT_OAUTH_TOKEN,
      codexModel: "gpt-5.4",
      betterAuthSecret: environment.BETTER_AUTH_SECRET,
      betterAuthUrl: environment.BETTER_AUTH_URL,
      dashboardOrigin: environment.DASHBOARD_ORIGIN,
      ssoIssuer: environment.SSO_ISSUER,
      ssoAllowedDomain: environment.SSO_ALLOWED_DOMAIN,
      ssoClientId: environment.SSO_CLIENT_ID,
      ssoClientSecret: environment.SSO_CLIENT_SECRET,
      resendApiKey: environment.RESEND_API_KEY,
      resendFromEmail: environment.RESEND_FROM_EMAIL,
      resendWebhookSecret: environment.RESEND_WEBHOOK_SECRET,
      mcpEnabled: environment.MCP_ENABLED,
      webhookTriggerEncryptionKey: environment.WEBHOOK_TRIGGER_ENCRYPTION_KEY,
    });
  });

  it("uses separate read-only endpoints for provider capabilities", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("openid-configuration")) {
        return new Response(JSON.stringify({
          issuer: environment.SSO_ISSUER,
          authorization_endpoint: `${environment.SSO_ISSUER}/authorize`,
        }));
      }
      if (url.includes("api.resend.com/domains")) {
        return new Response(JSON.stringify({
          data: [{ name: "example.com", status: "verified" }],
        }));
      }
      if (url.includes("/v6/deployments")) {
        return new Response(JSON.stringify({ deployments: [{ readyState: "READY" }] }));
      }
      return new Response(JSON.stringify({}));
    });

    const probes = probesForEnvironment(configFromEnvironment(settings));
    const signal = new AbortController().signal;
    for (const id of [
      "sso.discovery",
      "email.sender",
      "mcp.contract",
      "agent.model",
    ]) {
      expect(probes[id], id).toBeTypeOf("function");
      await expect(probes[id]!(signal), id).resolves.not.toBeInstanceOf(Error);
    }
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(
      expect.arrayContaining([
        "https://sso.example/.well-known/openid-configuration",
        "https://api.resend.com/domains",
      ]),
    );
  });


  // The Jira checks this suite used to hold left with S12. An integration
  // answers for its own provider now, so what a token Jira did not accept, a
  // project key that names nothing and a webhook registered somewhere else
  // read like is proved in `integrations/jira/worker.test.ts`, and whether a
  // delivery actually arrived is the generic `webhook-delivery` check in
  // `integration-health.ts`.

  it("omits a fake probe for OAuth-only agent tokens instead of inventing a result", () => {
    const config: SystemHealthConfig = {
      agentKind: "codex",
      codexOauthToken: "oauth-token",
      codexModel: "gpt-test",
      mcpEnabled: false,
    };
    expect(probesForEnvironment(config)["agent.model"]).toBeUndefined();
  });

  it("accepts a restricted send-only Resend key as a verified key, not down", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ name: "restricted_api_key" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await probesForEnvironment(configFromEnvironment(settings))["email.sender"]?.(
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      mode: "live",
      message: expect.stringContaining("send-only key"),
    });
  });

  it("does not mark a malformed Resend domain response as verified", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}));

    await expect(
      probesForEnvironment(configFromEnvironment(settings))["email.sender"]?.(
        new AbortController().signal,
      ),
    ).rejects.toThrow(/sender-domain verification data/);
  });

  it("reports a Resend webhook that omits handled delivery events", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        data: [
          {
            endpoint: "https://worker.example/webhooks/resend",
            status: "enabled",
            events: ["email.delivered"],
          },
        ],
      }),
    );

    await expect(
      probesForEnvironment(configFromEnvironment(settings))["email.webhook-delivery"]?.(
        new AbortController().signal,
      ),
    ).rejects.toThrow(/missing required events/);
  });

  it("leaves GitLab health to the integration package", () => {
    const probes = probesForEnvironment(configFromEnvironment(settings));
    expect(Object.keys(probes).filter((id) => id.startsWith("gitlab."))).toEqual([]);
  });
});
