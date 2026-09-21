import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RETIRED_ENVIRONMENT_VARIABLES } from "@shared/contracts";
import { DEFAULT_MODELS, resolveModelDefaults } from "@shared/harness";

async function importEnvModule() {
  const retiredEnvironment = await import(
    "./src/services/settings/retired-environment.js"
  );
  retiredEnvironment.assertNoRetiredEnvironmentVariables(process.env);
  const [config, botIdentity] = await Promise.all([
    import("./src/infra/vcs-config.js"),
    import("./src/services/vcs/vcs-bot-login.js"),
  ]);
  return { ...config, getVcsBotLogin: botIdentity.getVcsBotLogin };
}

describe("env", () => {
  const VALID_ENV = {
    ISSUE_TRACKER_KIND: "jira",
    JIRA_BASE_URL: "https://test.atlassian.net",
    JIRA_API_TOKEN: "token",
    JIRA_PROJECT_KEY: "PROJ",
    GITHUB_APP_ID: "123456",
    // base64 of: -----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n
    GITHUB_APP_PRIVATE_KEY: "LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCkZBS0UKLS0tLS1FTkQgUFJJVkFURSBLRVktLS0tLQo=",
    GITHUB_INSTALLATION_ID: "789012",
    GITHUB_OWNER: "test-org",
    GITHUB_REPO: "test-repo",
    CHAT_SDK_SLACK_TOKEN: "xoxb-test",
    CHAT_SDK_CHANNEL_ID: "C123",
    SLACK_SIGNING_SECRET: "fake-signing-secret",
    ANTHROPIC_API_KEY: "sk-ant-test",
    DATABASE_URL: "postgresql://user:pass@ep-fake.neon.tech/neondb",
    GITHUB_WEBHOOK_SECRET: "github-webhook-secret",
    BETTER_AUTH_SECRET: "x".repeat(32),
    BETTER_AUTH_URL: "https://worker.example.com",
    DASHBOARD_ORIGIN: "https://dashboard.example.com",
    DASHBOARD_AUTH_EMAIL: "admin@example.com",
    DASHBOARD_AUTH_PASSWORD: "supersecret",
  };

  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("parses valid env", async () => {
    Object.assign(process.env, VALID_ENV);
    const { env } = await importEnvModule();
    expect(env.JIRA_BASE_URL).toBe("https://test.atlassian.net");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
  });

  it("accepts optional Jira transition ids", async () => {
    Object.assign(process.env, {
      ...VALID_ENV,
      JIRA_BACKLOG_TRANSITION_ID: "11",
      JIRA_AI_REVIEW_TRANSITION_ID: "31",
    });

    const { env } = await importEnvModule();
    expect(env.JIRA_BACKLOG_TRANSITION_ID).toBe("11");
    expect(env.JIRA_AI_REVIEW_TRANSITION_ID).toBe("31");
  });

  it("uses defaults for optional fields", async () => {
    Object.assign(process.env, VALID_ENV);
    const { env } = await importEnvModule();
    expect(
      resolveModelDefaults({
        claude: undefined,
        codex: undefined,
      }),
    ).toEqual(DEFAULT_MODELS);
    // COMMIT_AUTHOR/EMAIL are optional with no defaults — provisionSandbox
    // derives the bot identity from the GitHub App when both are unset.
    expect(env.COMMIT_AUTHOR).toBeUndefined();
    expect(env.COMMIT_EMAIL).toBeUndefined();
  });

  it("uses safe MCP defaults", async () => {
    Object.assign(process.env, VALID_ENV);

    const { env } = await importEnvModule();

    expect(env.MCP_SERVER_VERSION).toBe("0.1.0");
    expect(env.MCP_ALLOW_PUBLIC_DCR).toBe(false);
    expect(env.MCP_DOGFOOD_FIXTURE_PREFIX).toBe("mcp-dogfood");
  });

  it("rejects an invalid MCP server version", async () => {
    Object.assign(process.env, VALID_ENV, { MCP_SERVER_VERSION: "latest" });

    await expect(importEnvModule()).rejects.toThrow("Invalid environment variables");
  });

  it("refuses every retired settings variable set at boot and names all offenders", async () => {
    Object.assign(
      process.env,
      VALID_ENV,
      Object.fromEntries(RETIRED_ENVIRONMENT_VARIABLES.map((name) => [name, "1"])),
    );

    await expect(importEnvModule()).rejects.toThrow(
      `Retired settings variables are still set: ${RETIRED_ENVIRONMENT_VARIABLES.join(", ")}`,
    );
    await expect(importEnvModule()).rejects.toThrow(
      /Remove these variables and follow the replacement documented in SETUP\.md/,
    );
    await expect(importEnvModule()).rejects.toThrow(
      /SETUP\.md, section "Removing migrated environment variables"/,
    );
  });

  it("accepts complete SSO env group", async () => {
    Object.assign(process.env, {
      ...VALID_ENV,
      SSO_ISSUER: "https://accounts.google.com",
      SSO_ALLOWED_DOMAIN: "example.com",
      SSO_CLIENT_ID: "client-id",
      SSO_CLIENT_SECRET: "client-secret",
    });

    const { env } = await importEnvModule();
    expect(env.SSO_ISSUER).toBe("https://accounts.google.com");
    expect(env.SSO_ALLOWED_DOMAIN).toBe("example.com");
    expect(env.SSO_CLIENT_ID).toBe("client-id");
    expect(env.SSO_CLIENT_SECRET).toBe("client-secret");
  });

  it("rejects partial SSO config with a helpful error", async () => {
    Object.assign(process.env, {
      ...VALID_ENV,
      SSO_ISSUER: "https://accounts.google.com",
    });

    await expect(async () => {
      await importEnvModule();
    }).rejects.toThrow(
      "SSO_ISSUER, SSO_ALLOWED_DOMAIN, SSO_CLIENT_ID, and SSO_CLIENT_SECRET",
    );
  });

  it("requires Resend sender config when RESEND_API_KEY is set", async () => {
    Object.assign(process.env, {
      ...VALID_ENV,
      RESEND_API_KEY: "re_test",
    });

    await expect(async () => {
      await importEnvModule();
    }).rejects.toThrow("RESEND_FROM_EMAIL");
  });

  it("requires Resend API key when RESEND_WEBHOOK_SECRET is set", async () => {
    Object.assign(process.env, {
      ...VALID_ENV,
      RESEND_WEBHOOK_SECRET: "whsec_test",
    });

    await expect(async () => {
      await importEnvModule();
    }).rejects.toThrow("RESEND_API_KEY");
  });

  it("uses the fixed redeploy-owned organization slug default", async () => {
    Object.assign(process.env, VALID_ENV);

    const { env } = await importEnvModule();
    expect(env.DASHBOARD_ORG_SLUG).toBe("ai-workflow");
  });

  it("throws when only one of COMMIT_AUTHOR / COMMIT_EMAIL is set", async () => {
    Object.assign(process.env, { ...VALID_ENV, COMMIT_AUTHOR: "custom-bot" });
    await expect(async () => {
      await importEnvModule();
    }).rejects.toThrow("COMMIT_AUTHOR and COMMIT_EMAIL must be set together");
  });

  it("throws on missing required field", async () => {
    const partial = { ...VALID_ENV };
    delete (partial as any).JIRA_API_TOKEN;
    Object.assign(process.env, partial);
    await expect(async () => {
      await importEnvModule();
    }).rejects.toThrow();
  });

  it("carries no version control provider configuration at all", async () => {
    // Every one of these used to be parsed into a provider config core built an
    // adapter from. They are an integration's connection fields now, read by
    // the integration and never by core, so a deployment can set all of them
    // and core still knows nothing about a provider.
    Object.assign(process.env, {
      ...VALID_ENV,
      GITLAB_TOKEN: "glpat-test",
      GITLAB_HOST: "https://gitlab.example.com",
      GITLAB_WEBHOOK_SECRET: "gitlab-webhook-secret",
    });

    const config = await importEnvModule();
    const values = config.env as Record<string, unknown>;

    for (const name of [
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_INSTALLATION_ID",
      "GITHUB_WEBHOOK_SECRET",
      "GITHUB_BOT_LOGIN",
      "GITHUB_OWNER",
      "GITHUB_REPO",
      "GITLAB_TOKEN",
      "GITLAB_HOST",
      "GITLAB_WEBHOOK_SECRET",
    ]) {
      expect(values[name]).toBeUndefined();
    }
    expect(Object.keys(config)).not.toContain("getConfiguredVcsProviders");
    expect(Object.keys(config)).not.toContain("getVcsProviderConfig");
  });

  it("leaves bot identity unset when no review bot login is configured", async () => {
    Object.assign(process.env, VALID_ENV);
    delete process.env.VCS_BOT_LOGIN;
    delete process.env.GITHUB_BOT_LOGIN;
    delete process.env.GITLAB_BOT_LOGIN;

    const { getVcsBotLogin } = await importEnvModule();

    await expect(getVcsBotLogin("github")).resolves.toBeUndefined();
    await expect(getVcsBotLogin("gitlab")).resolves.toBeUndefined();
  });

  it("rejects a whitespace-only VCS_BOT_LOGIN", async () => {
    // The one bot login core still reads. A per-provider one is a connection
    // field, validated where the connection is saved.
    Object.assign(process.env, VALID_ENV, { VCS_BOT_LOGIN: "   " });

    await expect(importEnvModule()).rejects.toThrow();
  });

  it("starts with no provider credentials, and with half a set, because a connection is checked where it is made", async () => {
    // Both of these refused to boot before S11: a deployment with three of the
    // four GitHub App values, and one with the App configured and no webhook
    // secret. A worker that will not start says nothing to the person who can
    // fix it, so the check moved to the Integrations page, where the same two
    // states are rows naming the variable to set.
    const partial = { ...VALID_ENV } as Record<string, string>;
    delete partial.GITHUB_APP_ID;
    delete partial.GITHUB_WEBHOOK_SECRET;
    Object.assign(process.env, partial);
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_WEBHOOK_SECRET;

    await expect(importEnvModule()).resolves.toBeDefined();
  });
});
