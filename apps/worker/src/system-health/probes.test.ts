import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemHealthConfig } from "./collect.js";

const environment = vi.hoisted(() => ({
  DATABASE_URL: "postgres://db.example/workflow",
  JIRA_BASE_URL: "https://jira.example",
  JIRA_API_TOKEN: "jira-token",
  JIRA_PROJECT_KEY: "AIW",
  GITHUB_APP_ID: 11,
  GITHUB_APP_PRIVATE_KEY: "github-key",
  GITHUB_INSTALLATION_ID: 22,
  GITHUB_WEBHOOK_SECRET: "github-webhook",
  GITLAB_TOKEN: "gitlab-token",
  GITLAB_HOST: "https://gitlab.example",
  GITLAB_WEBHOOK_SECRET: "gitlab-webhook",
  AGENT_KIND: "codex" as const,
  ANTHROPIC_API_KEY: "anthropic-key",
  CLAUDE_MODEL: "claude-test",
  CODEX_API_KEY: "openai-key",
  CODEX_CHATGPT_OAUTH_TOKEN: "codex-oauth",
  CODEX_MODEL: "gpt-test",
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
  GENAI_ENGINE_API_KEY: "arthur-key",
  GENAI_ENGINE_TRACE_ENDPOINT: "https://arthur.example/api/v1/traces",
  MCP_ENABLED: true,
  VERCEL_ENV: undefined,
  VERCEL_TOKEN: "vercel-token",
  VERCEL_TEAM_ID: "team-id",
  VERCEL_PROJECT_ID: "project/id",
}));

vi.mock("../../env.js", () => ({ env: environment }));
vi.mock("../mcp/contract-artifact.js", () => ({
  MCP_CONTRACT_ARTIFACT: { tools: [{ name: "system.capabilities" }] },
}));
const getInstallation = vi.hoisted(() => vi.fn().mockResolvedValue({ data: {} }));
vi.mock("../lib/github-auth.js", () => ({
  buildOctokit: () => ({ apps: { getInstallation } }),
}));

const { configFromEnvironment, probesForEnvironment } = await import("./probes.js");

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

describe("deployment system-health probes", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("maps every health variable from the validated runtime environment", () => {
    expect(configFromEnvironment()).toEqual({
      databaseUrl: environment.DATABASE_URL,
      jiraBaseUrl: environment.JIRA_BASE_URL,
      jiraApiToken: environment.JIRA_API_TOKEN,
      jiraProjectKey: environment.JIRA_PROJECT_KEY,
      githubAppId: environment.GITHUB_APP_ID,
      githubAppPrivateKey: environment.GITHUB_APP_PRIVATE_KEY,
      githubInstallationId: environment.GITHUB_INSTALLATION_ID,
      githubWebhookSecret: environment.GITHUB_WEBHOOK_SECRET,
      gitlabToken: environment.GITLAB_TOKEN,
      gitlabHost: environment.GITLAB_HOST,
      gitlabWebhookSecret: environment.GITLAB_WEBHOOK_SECRET,
      agentKind: environment.AGENT_KIND,
      anthropicApiKey: environment.ANTHROPIC_API_KEY,
      anthropicModel: environment.CLAUDE_MODEL,
      codexApiKey: environment.CODEX_API_KEY,
      codexOauthToken: environment.CODEX_CHATGPT_OAUTH_TOKEN,
      codexModel: environment.CODEX_MODEL,
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
      slackToken: environment.CHAT_SDK_SLACK_TOKEN,
      slackChannelId: environment.CHAT_SDK_CHANNEL_ID,
      arthurApiKey: environment.GENAI_ENGINE_API_KEY,
      arthurTraceEndpoint: environment.GENAI_ENGINE_TRACE_ENDPOINT,
      mcpEnabled: environment.MCP_ENABLED,
      vercelEnv: environment.VERCEL_ENV,
      vercelToken: environment.VERCEL_TOKEN,
      vercelTeamId: environment.VERCEL_TEAM_ID,
      vercelProjectId: environment.VERCEL_PROJECT_ID,
    });
  });

  it("uses read-only provider endpoints with bounded abort signals", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("openid-configuration")) {
        return new Response(JSON.stringify({ issuer: environment.SSO_ISSUER }));
      }
      if (url.includes("slack.com")) {
        return new Response(JSON.stringify({ ok: true }));
      }
      return new Response(JSON.stringify({}));
    });

    const config = configFromEnvironment();
    const probes = probesForEnvironment(config);
    const controller = new AbortController();
    for (const id of ["github", "sso", "email", "slack", "arthur", "mcp", "vercel", "agent"] as const) {
      await expect(probes[id]?.(controller.signal), id).resolves.toBeUndefined();
    }
    expect(getInstallation).toHaveBeenCalledWith({
      installation_id: environment.GITHUB_INSTALLATION_ID,
      request: { signal: controller.signal },
    });

    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      authorization: (init?.headers as Record<string, string> | undefined)?.Authorization,
      method: init?.method ?? "GET",
      signal: init?.signal,
    }));
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: "https://sso.example/.well-known/openid-configuration",
        signal: controller.signal,
      }),
      expect.objectContaining({
        url: "https://api.resend.com/domains",
        authorization: "Bearer resend-key",
      }),
      expect.objectContaining({
        url: "https://slack.com/api/auth.test",
        authorization: "Bearer slack-token",
        method: "POST",
      }),
      expect.objectContaining({
        url: "https://arthur.example/api/v2/tasks?page_size=1",
        authorization: "Bearer arthur-key",
      }),
      expect.objectContaining({
        url: "https://api.vercel.com/v9/projects/project%2Fid?teamId=team-id",
        authorization: "Bearer vercel-token",
      }),
      expect.objectContaining({
        url: "https://api.openai.com/v1/models/gpt-test",
        authorization: "Bearer openai-key",
      }),
    ]));
  });

  it("does not create probes for presence-only credential modes", () => {
    const config: SystemHealthConfig = {
      agentKind: "codex",
      codexOauthToken: "oauth-token",
      codexModel: "gpt-test",
      mcpEnabled: false,
      vercelEnv: "production",
    };
    const probes = probesForEnvironment(config);
    expect(probes.agent).toBeUndefined();
    expect(probes.vercel).toBeUndefined();
    expect(probes.mcp).toBeUndefined();
  });

  it("accepts a valid send-only Resend key without requiring full account access", async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ name: "restricted_api_key" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    ));
    const probe = probesForEnvironment(configFromEnvironment()).email;
    await expect(probe?.(new AbortController().signal)).resolves.toBeUndefined();
  });
});
