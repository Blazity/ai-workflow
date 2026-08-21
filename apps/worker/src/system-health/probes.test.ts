import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemHealthConfig } from "./collect.js";

const environment = vi.hoisted(() => ({
  DATABASE_URL: "postgres://db.example/workflow",
  JIRA_BASE_URL: "https://jira.example",
  JIRA_API_TOKEN: "jira-token",
  JIRA_PROJECT_KEY: "AIW",
  JIRA_WEBHOOK_SECRET: "jira-webhook",
  GITHUB_APP_ID: 11,
  GITHUB_APP_PRIVATE_KEY: "github-key",
  GITHUB_INSTALLATION_ID: 22,
  GITHUB_WEBHOOK_SECRET: "github-webhook",
  GITLAB_TOKEN: "gitlab-token",
  GITLAB_HOST: "https://gitlab.example",
  GITLAB_WEBHOOK_SECRET: "gitlab-webhook",
  GITLAB_PROJECT_ID: "group/project",
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
  SLACK_SIGNING_SECRET: "slack-signing",
  SLACK_ALLOWED_USER_IDS: "U1,U2",
  GENAI_ENGINE_API_KEY: "arthur-key",
  GENAI_ENGINE_TRACE_ENDPOINT: "https://arthur.example/api/v1/traces",
  MCP_ENABLED: true,
  WEBHOOK_TRIGGER_ENCRYPTION_KEY: "a".repeat(64),
  VERCEL_ENV: undefined,
  VERCEL_TOKEN: "vercel-token",
  VERCEL_TEAM_ID: "team-id",
  VERCEL_PROJECT_ID: "project/id",
}));

vi.mock("../../env.js", () => ({ env: environment }));
const getLatestSystemHealthObservations = vi.hoisted(() =>
  vi.fn().mockResolvedValue([]),
);
vi.mock("../db/client.js", () => ({ getDb: () => ({}) }));
vi.mock("./observations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./observations.js")>()),
  getLatestSystemHealthObservations,
}));
vi.mock("../mcp/contract-artifact.js", () => ({
  MCP_CONTRACT_ARTIFACT: {
    contractHash: "hash",
    tools: [{ name: "system.capabilities" }],
  },
}));
const getInstallation = vi.hoisted(() => vi.fn().mockResolvedValue({ data: {} }));
const listReposAccessibleToInstallation = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ data: { total_count: 3, repositories: [{}] } }),
);
vi.mock("../lib/github-auth.js", () => ({
  buildOctokit: () => ({
    apps: { getInstallation, listReposAccessibleToInstallation },
  }),
}));
vi.mock("@octokit/auth-app", () => ({
  createAppAuth: () => async () => ({ token: "app-jwt" }),
}));

const { configFromEnvironment, probesForEnvironment } = await import("./probes.js");
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

describe("deployment system-health probes", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    getInstallation.mockClear();
    listReposAccessibleToInstallation.mockClear();
    getLatestSystemHealthObservations.mockReset().mockResolvedValue([]);
  });

  it("maps credentials for every independently checked capability", () => {
    expect(configFromEnvironment()).toEqual({
      databaseUrl: environment.DATABASE_URL,
      jiraBaseUrl: environment.JIRA_BASE_URL,
      jiraApiToken: environment.JIRA_API_TOKEN,
      jiraProjectKey: environment.JIRA_PROJECT_KEY,
      jiraWebhookSecret: environment.JIRA_WEBHOOK_SECRET,
      githubAppId: environment.GITHUB_APP_ID,
      githubAppPrivateKey: environment.GITHUB_APP_PRIVATE_KEY,
      githubInstallationId: environment.GITHUB_INSTALLATION_ID,
      githubWebhookSecret: environment.GITHUB_WEBHOOK_SECRET,
      gitlabToken: environment.GITLAB_TOKEN,
      gitlabHost: environment.GITLAB_HOST,
      gitlabWebhookSecret: environment.GITLAB_WEBHOOK_SECRET,
      gitlabProjectId: environment.GITLAB_PROJECT_ID,
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
      slackSigningSecret: environment.SLACK_SIGNING_SECRET,
      slackAllowedUserIds: environment.SLACK_ALLOWED_USER_IDS,
      arthurApiKey: environment.GENAI_ENGINE_API_KEY,
      arthurTraceEndpoint: environment.GENAI_ENGINE_TRACE_ENDPOINT,
      mcpEnabled: environment.MCP_ENABLED,
      webhookTriggerEncryptionKey: environment.WEBHOOK_TRIGGER_ENCRYPTION_KEY,
      vercelEnv: environment.VERCEL_ENV,
      vercelToken: environment.VERCEL_TOKEN,
      vercelTeamId: environment.VERCEL_TEAM_ID,
      vercelProjectId: environment.VERCEL_PROJECT_ID,
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
      if (url.includes("slack.com")) return new Response(JSON.stringify({ ok: true }));
      if (url.includes("/v6/deployments")) {
        return new Response(JSON.stringify({ deployments: [{ readyState: "READY" }] }));
      }
      return new Response(JSON.stringify({}));
    });

    const probes = probesForEnvironment(configFromEnvironment());
    const signal = new AbortController().signal;
    for (const id of [
      "github.app-installation",
      "github.repositories",
      "sso.discovery",
      "email.sender",
      "slack.bot-auth",
      "slack.channel",
      "arthur.api",
      "mcp.contract",
      "vercel.project",
      "vercel.production-deployment",
      "agent.model",
    ]) {
      expect(probes[id], id).toBeTypeOf("function");
      await expect(probes[id]!(signal), id).resolves.not.toBeInstanceOf(Error);
    }
    expect(getInstallation).toHaveBeenCalledOnce();
    expect(listReposAccessibleToInstallation).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(
      expect.arrayContaining([
        "https://sso.example/.well-known/openid-configuration",
        "https://api.resend.com/domains",
        "https://slack.com/api/auth.test",
        "https://slack.com/api/conversations.info",
      ]),
    );
  });

  it("keeps OAuth-only agent modes unverified by omitting a fake probe", () => {
    const config: SystemHealthConfig = {
      agentKind: "codex",
      codexOauthToken: "oauth-token",
      codexModel: "gpt-test",
      mcpEnabled: false,
    };
    expect(probesForEnvironment(config)["agent.model"]).toBeUndefined();
  });

  it("does not mark GitHub repository access live when the installation is empty", async () => {
    listReposAccessibleToInstallation.mockResolvedValueOnce({
      data: { total_count: 0, repositories: [] },
    });

    await expect(
      probesForEnvironment(configFromEnvironment())["github.repositories"]?.(
        new AbortController().signal,
      ),
    ).rejects.toThrow(/no accessible repositories/);
  });

  it("does not mark GitLab repository access live when the token sees no projects", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("[]", { headers: { "x-total": "0" } }),
    );
    const config = { ...configFromEnvironment(), gitlabProjectId: undefined };

    await expect(
      probesForEnvironment(config)["gitlab.repositories"]?.(
        new AbortController().signal,
      ),
    ).rejects.toThrow(/no accessible projects/);
  });

  it("reports a GitHub App that omits handled webhook events", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/app")) {
        return Response.json({ events: ["pull_request"] });
      }
      if (url.includes("/hook/config")) {
        return Response.json({
          url: "https://worker.example/webhooks/github",
          insecure_ssl: "0",
        });
      }
      if (url.includes("/hook/deliveries")) return Response.json([]);
      throw new Error(`Unexpected request: ${url}`);
    });

    await expect(
      probesForEnvironment(configFromEnvironment())["github.webhook-delivery"]?.(
        new AbortController().signal,
      ),
    ).rejects.toThrow(/missing required webhook events/);
  });

  it("does not reuse a successful GitHub delivery from an old webhook secret", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/app")) {
        return Response.json({
          events: [
            "check_run",
            "issue_comment",
            "pull_request",
            "pull_request_review",
            "pull_request_review_comment",
          ],
        });
      }
      if (url.includes("/hook/config")) {
        return Response.json({
          url: "https://worker.example/webhooks/github",
          insecure_ssl: "0",
        });
      }
      if (url.includes("/hook/deliveries")) {
        return Response.json([
          { delivered_at: new Date().toISOString(), status_code: 200 },
        ]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await probesForEnvironment(configFromEnvironment())[
      "github.webhook-delivery"
    ]?.(new AbortController().signal);

    expect(result).toMatchObject({
      mode: "unverified",
      message: expect.stringContaining("current webhook secret"),
    });
    expect(getLatestSystemHealthObservations).toHaveBeenCalledWith(
      expect.anything(),
      "github",
      "webhook-delivery",
      expect.stringMatching(/^deployment:[a-f0-9]{64}$/),
    );
  });

  it("accepts GitHub delivery evidence tied to the current webhook secret", async () => {
    getLatestSystemHealthObservations.mockResolvedValueOnce([
      {
        outcome: "accepted",
        reason: "request_succeeded",
        count: 1,
        observedAt: new Date(),
      },
    ]);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/app")) {
        return Response.json({
          events: [
            "check_run",
            "issue_comment",
            "pull_request",
            "pull_request_review",
            "pull_request_review_comment",
          ],
        });
      }
      if (url.includes("/hook/config")) {
        return Response.json({
          url: "https://worker.example/webhooks/github",
          insecure_ssl: "0",
        });
      }
      if (url.includes("/hook/deliveries")) {
        return Response.json([
          { delivered_at: new Date().toISOString(), status_code: 200 },
        ]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await probesForEnvironment(configFromEnvironment())[
      "github.webhook-delivery"
    ]?.(new AbortController().signal);

    expect(result).toMatchObject({ mode: "live" });
  });

  it("accepts a restricted send-only Resend key as unverified, not down", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ name: "restricted_api_key" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await probesForEnvironment(configFromEnvironment())["email.sender"]?.(
      new AbortController().signal,
    );
    expect(result).toMatchObject({ mode: "unverified" });
  });

  it("does not mark a malformed Resend domain response as verified", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}));

    await expect(
      probesForEnvironment(configFromEnvironment())["email.sender"]?.(
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
      probesForEnvironment(configFromEnvironment())["email.webhook-delivery"]?.(
        new AbortController().signal,
      ),
    ).rejects.toThrow(/missing required events/);
  });

  it("bounds active GitLab webhook inspection to four concurrent projects", async () => {
    let activeHookLists = 0;
    let maxActiveHookLists = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/projects?")) {
        return new Response(
          JSON.stringify(
            Array.from({ length: 5 }, (_, index) => ({
              id: index + 1,
              path_with_namespace: `group/project-${index + 1}`,
            })),
          ),
          { headers: { "x-total": "5" } },
        );
      }
      if (/\/projects\/\d+\/hooks$/.test(url)) {
        activeHookLists += 1;
        maxActiveHookLists = Math.max(maxActiveHookLists, activeHookLists);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeHookLists -= 1;
        return Response.json([
          {
            id: 10,
            url: "https://worker.example/webhooks/gitlab",
            enable_ssl_verification: true,
            merge_requests_events: true,
            pipeline_events: true,
            note_events: true,
            token_present: true,
          },
        ]);
      }
      if (url.includes("/test/push_events")) {
        expect(init?.method).toBe("POST");
        return new Response(null, { status: 204 });
      }
      if (url.includes("/events?")) {
        return Response.json([
          { created_at: "2026-08-21T10:00:00.000Z", response_status: 200 },
        ]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const config = { ...configFromEnvironment(), gitlabProjectId: undefined };

    const result = await probesForEnvironment(config, { active: true })[
      "gitlab.webhook-delivery"
    ]?.(new AbortController().signal);

    expect(maxActiveHookLists).toBe(4);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/test/push_events"),
      ),
    ).toHaveLength(4);
    expect(result).toMatchObject({
      mode: "unverified",
      coverage: { checked: 5, total: 5 },
    });
  });

  it("treats a rate-limited active GitLab test as unverified", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/projects/group%2Fproject") && !url.includes("/hooks")) {
        return Response.json({ id: 1, path_with_namespace: "group/project" });
      }
      if (url.endsWith("/projects/1/hooks")) {
        return Response.json([
          {
            id: 10,
            url: "https://worker.example/webhooks/gitlab",
            enable_ssl_verification: true,
            merge_requests_events: true,
            pipeline_events: true,
            note_events: true,
            token_present: true,
          },
        ]);
      }
      if (url.includes("/test/push_events")) {
        expect(init?.method).toBe("POST");
        return new Response(null, { status: 429 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await probesForEnvironment(configFromEnvironment(), { active: true })[
      "gitlab.webhook-delivery"
    ]?.(new AbortController().signal);

    expect(result).toMatchObject({
      mode: "unverified",
      message: expect.stringContaining("rate-limited"),
    });
  });

  it("keeps a checked GitLab webhook failure visible with partial coverage", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/projects?")) {
        return new Response(
          JSON.stringify([
            { id: 1, path_with_namespace: "group/broken" },
            { id: 2, path_with_namespace: "group/healthy" },
          ]),
          { headers: { "x-total": "30" } },
        );
      }
      if (/\/projects\/\d+\/hooks$/.test(url)) {
        return Response.json([
          {
            id: 10,
            url: "https://worker.example/webhooks/gitlab",
            enable_ssl_verification: true,
            merge_requests_events: true,
            pipeline_events: true,
            note_events: true,
            token_present: true,
          },
        ]);
      }
      if (url.includes("/projects/1/") && url.includes("/events?")) {
        return Response.json([
          { created_at: "2026-08-21T09:00:00.000Z", response_status: 302 },
        ]);
      }
      if (url.includes("/events?")) {
        return Response.json([
          { created_at: "2026-08-21T10:00:00.000Z", response_status: 200 },
        ]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const config = { ...configFromEnvironment(), gitlabProjectId: undefined };

    const result = await probesForEnvironment(config)["gitlab.webhook-delivery"]?.(
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      mode: "down",
      coverage: { checked: 2, total: 30 },
      message: expect.stringContaining("HTTP 302"),
    });
  });
});
