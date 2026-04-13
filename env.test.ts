import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("env", () => {
  const VALID_ENV = {
    ISSUE_TRACKER_KIND: "jira",
    JIRA_BASE_URL: "https://test.atlassian.net",
    JIRA_EMAIL: "test@example.com",
    JIRA_API_TOKEN: "token",
    JIRA_PROJECT_KEY: "PROJ",
    COLUMN_AI: "AI",
    COLUMN_AI_REVIEW: "AI Review",
    COLUMN_BACKLOG: "Backlog",
    VCS_KIND: "github",
    GITHUB_TOKEN: "ghp_test",
    GITHUB_OWNER: "test-org",
    GITHUB_REPO: "test-repo",
    GITHUB_BASE_BRANCH: "main",
    CHAT_SDK_SLACK_TOKEN: "xoxb-test",
    CHAT_SDK_CHANNEL_ID: "C123",
    CHAT_SDK_BOT_NAME: "blazebot",
    ANTHROPIC_API_KEY: "sk-ant-test",
    CLAUDE_MODEL: "claude-opus-4-6",
    COMMIT_AUTHOR: "ai-workflow-blazity",
    COMMIT_EMAIL: "bot@blazity.com",
    MAX_CONCURRENT_AGENTS: "3",
    JOB_TIMEOUT_MS: "1800000",
    AI_WORKFLOW_KV_REST_API_URL: "https://fake.upstash.io",
    AI_WORKFLOW_KV_REST_API_TOKEN: "fake-token",
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
    delete (partial as any).COMMIT_AUTHOR;
    delete (partial as any).MAX_CONCURRENT_AGENTS;
    Object.assign(process.env, partial);
    const { env } = await import("./env.js");
    expect(env.COMMIT_AUTHOR).toBe("ai-workflow-blazity");
    expect(env.MAX_CONCURRENT_AGENTS).toBe(3);
  });

  it("throws on missing required field", async () => {
    const partial = { ...VALID_ENV };
    delete (partial as any).JIRA_API_TOKEN;
    Object.assign(process.env, partial);
    await expect(async () => {
      await import("./env.js");
    }).rejects.toThrow();
  });

  it("parses valid GitLab env", async () => {
    const gitlabEnv = { ...VALID_ENV };
    gitlabEnv.VCS_KIND = "gitlab";
    delete (gitlabEnv as any).GITHUB_TOKEN;
    delete (gitlabEnv as any).GITHUB_OWNER;
    delete (gitlabEnv as any).GITHUB_REPO;
    delete (gitlabEnv as any).GITHUB_BASE_BRANCH;
    (gitlabEnv as any).GITLAB_TOKEN = "glpat-test";
    (gitlabEnv as any).GITLAB_PROJECT_ID = "group/repo";
    (gitlabEnv as any).GITLAB_BASE_BRANCH = "develop";
    Object.assign(process.env, gitlabEnv);

    const { getVcsConfig } = await import("./env.js");
    const vcs = getVcsConfig();
    expect(vcs.kind).toBe("gitlab");
    expect(vcs.token).toBe("glpat-test");
    expect(vcs.repoPath).toBe("group/repo");
    expect(vcs.baseBranch).toBe("develop");
    expect(vcs.host).toBe("https://gitlab.com");
  });

  it("honors GITLAB_HOST for self-hosted instances", async () => {
    const gitlabEnv = { ...VALID_ENV };
    gitlabEnv.VCS_KIND = "gitlab";
    delete (gitlabEnv as any).GITHUB_TOKEN;
    delete (gitlabEnv as any).GITHUB_OWNER;
    delete (gitlabEnv as any).GITHUB_REPO;
    (gitlabEnv as any).GITLAB_TOKEN = "glpat-test";
    (gitlabEnv as any).GITLAB_PROJECT_ID = "group/repo";
    (gitlabEnv as any).GITLAB_HOST = "https://gitlab.example.com";
    Object.assign(process.env, gitlabEnv);

    const { getVcsConfig } = await import("./env.js");
    expect(getVcsConfig().host).toBe("https://gitlab.example.com");
  });

  it("throws at startup when VCS_KIND=gitlab but GitLab vars missing", async () => {
    const gitlabEnv = { ...VALID_ENV };
    gitlabEnv.VCS_KIND = "gitlab";
    delete (gitlabEnv as any).GITHUB_TOKEN;
    delete (gitlabEnv as any).GITHUB_OWNER;
    delete (gitlabEnv as any).GITHUB_REPO;
    Object.assign(process.env, gitlabEnv);

    // Fail-fast: module import itself must throw before any workflow runs.
    await expect(async () => {
      await import("./env.js");
    }).rejects.toThrow("VCS_KIND=gitlab requires GITLAB_TOKEN and GITLAB_PROJECT_ID");
  });

  it("throws at startup when VCS_KIND=github but GitHub vars missing", async () => {
    const partial = { ...VALID_ENV };
    delete (partial as any).GITHUB_TOKEN;
    Object.assign(process.env, partial);

    await expect(async () => {
      await import("./env.js");
    }).rejects.toThrow("VCS_KIND=github requires GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO");
  });

  it("getVcsConfig returns GitHub config", async () => {
    Object.assign(process.env, VALID_ENV);
    const { getVcsConfig } = await import("./env.js");
    const vcs = getVcsConfig();
    expect(vcs.kind).toBe("github");
    expect(vcs.token).toBe("ghp_test");
    expect(vcs.repoPath).toBe("test-org/test-repo");
    expect(vcs.baseBranch).toBe("main");
    expect(vcs.host).toBe("https://github.com");
  });
});
