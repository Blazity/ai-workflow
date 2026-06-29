import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("env", () => {
  const VALID_ENV = {
    ISSUE_TRACKER_KIND: "jira",
    JIRA_BASE_URL: "https://test.atlassian.net",
    JIRA_API_TOKEN: "token",
    JIRA_PROJECT_KEY: "PROJ",
    COLUMN_AI: "AI",
    COLUMN_AI_REVIEW: "AI Review",
    COLUMN_BACKLOG: "Backlog",
    VCS_KIND: "github",
    GITHUB_APP_ID: "123456",
    // base64 of: -----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n
    GITHUB_APP_PRIVATE_KEY: "LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCkZBS0UKLS0tLS1FTkQgUFJJVkFURSBLRVktLS0tLQo=",
    GITHUB_INSTALLATION_ID: "789012",
    GITHUB_OWNER: "test-org",
    GITHUB_REPO: "test-repo",
    GITHUB_BASE_BRANCH: "main",
    CHAT_SDK_SLACK_TOKEN: "xoxb-test",
    CHAT_SDK_CHANNEL_ID: "C123",
    CHAT_SDK_BOT_NAME: "blazebot",
    SLACK_SIGNING_SECRET: "fake-signing-secret",
    ANTHROPIC_API_KEY: "sk-ant-test",
    CLAUDE_MODEL: "claude-opus-4-6",
    MAX_CONCURRENT_AGENTS: "3",
    JOB_TIMEOUT_MS: "1800000",
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
    const { env } = await import("./env.js");
    expect(env.JIRA_BASE_URL).toBe("https://test.atlassian.net");
    expect(env.MAX_CONCURRENT_AGENTS).toBe(3);
    expect(env.JOB_TIMEOUT_MS).toBe(1800000);
  });

  it("uses defaults for optional fields", async () => {
    const partial = { ...VALID_ENV };
    delete (partial as any).MAX_CONCURRENT_AGENTS;
    Object.assign(process.env, partial);
    const { env } = await import("./env.js");
    expect(env.MAX_CONCURRENT_AGENTS).toBe(3);
    // COMMIT_AUTHOR/EMAIL are optional with no defaults — provisionSandbox
    // derives the bot identity from the GitHub App when both are unset.
    expect(env.COMMIT_AUTHOR).toBeUndefined();
    expect(env.COMMIT_EMAIL).toBeUndefined();
  });

  it("accepts complete SSO env group", async () => {
    Object.assign(process.env, {
      ...VALID_ENV,
      SSO_ISSUER: "https://accounts.google.com",
      SSO_ALLOWED_DOMAIN: "example.com",
      SSO_CLIENT_ID: "client-id",
      SSO_CLIENT_SECRET: "client-secret",
    });

    const { env } = await import("./env.js");
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
      await import("./env.js");
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
      await import("./env.js");
    }).rejects.toThrow("RESEND_FROM_EMAIL");
  });

  it("requires Resend API key when RESEND_WEBHOOK_SECRET is set", async () => {
    Object.assign(process.env, {
      ...VALID_ENV,
      RESEND_WEBHOOK_SECRET: "whsec_test",
    });

    await expect(async () => {
      await import("./env.js");
    }).rejects.toThrow("RESEND_API_KEY");
  });

  it("uses fixed organization defaults", async () => {
    Object.assign(process.env, VALID_ENV);

    const { env } = await import("./env.js");
    expect(env.DASHBOARD_ORG_NAME).toBe("AI Workflow");
    expect(env.DASHBOARD_ORG_SLUG).toBe("ai-workflow");
  });

  it("throws when only one of COMMIT_AUTHOR / COMMIT_EMAIL is set", async () => {
    Object.assign(process.env, { ...VALID_ENV, COMMIT_AUTHOR: "custom-bot" });
    await expect(async () => {
      await import("./env.js");
    }).rejects.toThrow("COMMIT_AUTHOR and COMMIT_EMAIL must be set together");
  });

  it("throws on missing required field", async () => {
    const partial = { ...VALID_ENV };
    delete (partial as any).JIRA_API_TOKEN;
    Object.assign(process.env, partial);
    await expect(async () => {
      await import("./env.js");
    }).rejects.toThrow();
  });

  it("parses valid GitLab env without GitHub webhook secret", async () => {
    const gitlabEnv = { ...VALID_ENV };
    gitlabEnv.VCS_KIND = "gitlab";
    delete (gitlabEnv as any).GITHUB_APP_ID;
    delete (gitlabEnv as any).GITHUB_APP_PRIVATE_KEY;
    delete (gitlabEnv as any).GITHUB_INSTALLATION_ID;
    delete (gitlabEnv as any).GITHUB_OWNER;
    delete (gitlabEnv as any).GITHUB_REPO;
    delete (gitlabEnv as any).GITHUB_BASE_BRANCH;
    delete (gitlabEnv as any).GITHUB_WEBHOOK_SECRET;
    (gitlabEnv as any).GITLAB_TOKEN = "glpat-test";
    (gitlabEnv as any).GITLAB_PROJECT_ID = "group/repo";
    (gitlabEnv as any).GITLAB_BASE_BRANCH = "develop";
    (gitlabEnv as any).GITLAB_WEBHOOK_SECRET = "gitlab-webhook-secret";
    Object.assign(process.env, gitlabEnv);

    const { env, getVcsConfig } = await import("./env.js");
    expect(env.GITLAB_WEBHOOK_SECRET).toBe("gitlab-webhook-secret");
    const vcs = getVcsConfig();
    expect(vcs.kind).toBe("gitlab");
    expect(vcs.repoPath).toBe("group/repo");
  });

  it("honors GITLAB_HOST for self-hosted instances", async () => {
    const gitlabEnv = { ...VALID_ENV };
    gitlabEnv.VCS_KIND = "gitlab";
    delete (gitlabEnv as any).GITHUB_APP_ID;
    delete (gitlabEnv as any).GITHUB_APP_PRIVATE_KEY;
    delete (gitlabEnv as any).GITHUB_INSTALLATION_ID;
    delete (gitlabEnv as any).GITHUB_OWNER;
    delete (gitlabEnv as any).GITHUB_REPO;
    delete (gitlabEnv as any).GITHUB_BASE_BRANCH;
    (gitlabEnv as any).GITLAB_TOKEN = "glpat-test";
    (gitlabEnv as any).GITLAB_PROJECT_ID = "group/repo";
    (gitlabEnv as any).GITLAB_HOST = "https://gitlab.example.com";
    (gitlabEnv as any).GITLAB_WEBHOOK_SECRET = "gitlab-webhook-secret";
    Object.assign(process.env, gitlabEnv);

    const { getVcsConfig } = await import("./env.js");
    expect(getVcsConfig().host).toBe("https://gitlab.example.com");
  });

  it("throws at startup when VCS_KIND=gitlab but GitLab vars missing", async () => {
    const gitlabEnv = { ...VALID_ENV };
    gitlabEnv.VCS_KIND = "gitlab";
    delete (gitlabEnv as any).GITHUB_APP_ID;
    delete (gitlabEnv as any).GITHUB_APP_PRIVATE_KEY;
    delete (gitlabEnv as any).GITHUB_INSTALLATION_ID;
    delete (gitlabEnv as any).GITHUB_OWNER;
    delete (gitlabEnv as any).GITHUB_REPO;
    delete (gitlabEnv as any).GITHUB_BASE_BRANCH;
    Object.assign(process.env, gitlabEnv);

    // Fail-fast: module import itself must throw before any workflow runs.
    await expect(async () => {
      await import("./env.js");
    }).rejects.toThrow("VCS_KIND=gitlab requires GITLAB_TOKEN and GITLAB_PROJECT_ID");
  });

  it("throws at startup when VCS_KIND=github but GitHub App vars missing", async () => {
    const partial = { ...VALID_ENV };
    delete (partial as any).GITHUB_APP_ID;
    Object.assign(process.env, partial);

    await expect(async () => {
      await import("./env.js");
    }).rejects.toThrow(
      "VCS_KIND=github requires GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_INSTALLATION_ID, GITHUB_OWNER, and GITHUB_REPO",
    );
  });

  it("requires GITHUB_WEBHOOK_SECRET when VCS_KIND=github", async () => {
    const partial = { ...VALID_ENV };
    delete (partial as any).GITHUB_WEBHOOK_SECRET;
    Object.assign(process.env, partial);

    await expect(async () => {
      await import("./env.js");
    }).rejects.toThrow("VCS_KIND=github requires GITHUB_WEBHOOK_SECRET");
  });

  it("requires GITLAB_WEBHOOK_SECRET when VCS_KIND=gitlab", async () => {
    const gitlabEnv = { ...VALID_ENV };
    gitlabEnv.VCS_KIND = "gitlab";
    delete (gitlabEnv as any).GITHUB_APP_ID;
    delete (gitlabEnv as any).GITHUB_APP_PRIVATE_KEY;
    delete (gitlabEnv as any).GITHUB_INSTALLATION_ID;
    delete (gitlabEnv as any).GITHUB_OWNER;
    delete (gitlabEnv as any).GITHUB_REPO;
    delete (gitlabEnv as any).GITHUB_BASE_BRANCH;
    delete (gitlabEnv as any).GITHUB_WEBHOOK_SECRET;
    (gitlabEnv as any).GITLAB_TOKEN = "glpat-test";
    (gitlabEnv as any).GITLAB_PROJECT_ID = "group/repo";
    Object.assign(process.env, gitlabEnv);

    await expect(async () => {
      await import("./env.js");
    }).rejects.toThrow("VCS_KIND=gitlab requires GITLAB_WEBHOOK_SECRET");
  });

  it("getVcsConfig returns GitHub App config", async () => {
    Object.assign(process.env, VALID_ENV);
    const { getVcsConfig } = await import("./env.js");
    const vcs = getVcsConfig();
    expect(vcs.kind).toBe("github");
    if (vcs.kind !== "github") throw new Error("expected github");
    expect(vcs.auth.appId).toBe(123456);
    expect(vcs.auth.installationId).toBe(789012);
    expect(vcs.auth.privateKeyBase64).toBe(
      "LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCkZBS0UKLS0tLS1FTkQgUFJJVkFURSBLRVktLS0tLQo=",
    );
    expect(vcs.repoPath).toBe("test-org/test-repo");
    expect(vcs.baseBranch).toBe("main");
    expect(vcs.host).toBe("https://github.com");
  });
});
