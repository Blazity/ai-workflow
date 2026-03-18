import { describe, it, expect, vi, beforeEach } from "vitest";

describe("env", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("JIRA_WEBHOOK_SECRET", "test-secret");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-test");
  });

  it("validates when all required env vars are set", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    const { env } = await import("./env.js");
    expect(env.DATABASE_URL).toBe("postgresql://user:pass@localhost:5432/db");
    expect(env.REDIS_URL).toBe("redis://localhost:6379");
  });

  it("throws when REDIS_URL is missing", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");

    await expect(import("./env.js")).rejects.toThrow();
  });

  it("throws when JIRA_WEBHOOK_SECRET is missing", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    await expect(import("./env.js")).rejects.toThrow();
  });

  it("throws when MAX_CONCURRENT_AGENTS is not a positive integer", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("MAX_CONCURRENT_AGENTS", "0");

    await expect(import("./env.js")).rejects.toThrow();
  });

  it("uses default PORT of 3000", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    const { env } = await import("./env.js");
    expect(env.PORT).toBe(3000);
  });

  it("uses default MAX_CONCURRENT_AGENTS of 3", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    const { env } = await import("./env.js");
    expect(env.MAX_CONCURRENT_AGENTS).toBe(3);
  });

  it("parses MAX_CONCURRENT_AGENTS as integer", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("MAX_CONCURRENT_AGENTS", "5");

    const { env } = await import("./env.js");
    expect(env.MAX_CONCURRENT_AGENTS).toBe(5);
  });

  it("uses default NODE_ENV of development", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    delete process.env.NODE_ENV;

    const { env } = await import("./env.js");
    expect(env.NODE_ENV).toBe("development");
  });

  it("uses default COLUMN_AI of 'AI'", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    const { env } = await import("./env.js");
    expect(env.COLUMN_AI).toBe("AI");
  });

  it("allows overriding column names via env", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("COLUMN_AI", "Custom AI");

    const { env } = await import("./env.js");
    expect(env.COLUMN_AI).toBe("Custom AI");
  });

  it("uses default ISSUE_TRACKER_KIND of 'jira'", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    const { env } = await import("./env.js");
    expect(env.ISSUE_TRACKER_KIND).toBe("jira");
  });

  it("uses default MESSAGING_KIND of 'slack'", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    const { env } = await import("./env.js");
    expect(env.MESSAGING_KIND).toBe("slack");
  });

  it("uses default VCS_KIND of 'github'", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    const { env } = await import("./env.js");
    expect(env.VCS_KIND).toBe("github");
  });

  it("uses default JOB_TIMEOUT_MS of 600000", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    const { env } = await import("./env.js");
    expect(env.JOB_TIMEOUT_MS).toBe(600000);
  });

  it("throws when JOB_TIMEOUT_MS is not a positive integer", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("JOB_TIMEOUT_MS", "0");

    await expect(import("./env.js")).rejects.toThrow();
  });

  it("allows optional JIRA_BASE_URL", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    const { env } = await import("./env.js");
    expect(env.JIRA_BASE_URL).toBeUndefined();
  });

  it("parses JIRA_BASE_URL when set", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("JIRA_BASE_URL", "https://team.atlassian.net");

    const { env } = await import("./env.js");
    expect(env.JIRA_BASE_URL).toBe("https://team.atlassian.net");
  });

  it("uses default GITHUB_BASE_BRANCH of 'main'", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    const { env } = await import("./env.js");
    expect(env.GITHUB_BASE_BRANCH).toBe("main");
  });

  it("uses default COLUMN_AI_REVIEW of 'AI Review'", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    const { env } = await import("./env.js");
    expect(env.COLUMN_AI_REVIEW).toBe("AI Review");
  });

  it("uses default COLUMN_BACKLOG of 'Backlog'", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    const { env } = await import("./env.js");
    expect(env.COLUMN_BACKLOG).toBe("Backlog");
  });

  it("uses default SANDBOX_MEMORY_MB of 4096", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    const { env } = await import("./env.js");
    expect(env.SANDBOX_MEMORY_MB).toBe(4096);
  });

  it("uses default DOCKER_IMAGE of 'blazebot-sandbox'", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    const { env } = await import("./env.js");
    expect(env.DOCKER_IMAGE).toBe("blazebot-sandbox");
  });

  it("uses default JOB_MAX_RETRIES of 3", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    const { env } = await import("./env.js");
    expect(env.JOB_MAX_RETRIES).toBe(3);
  });

  it("allows overriding JOB_MAX_RETRIES via env", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("JOB_MAX_RETRIES", "5");

    const { env } = await import("./env.js");
    expect(env.JOB_MAX_RETRIES).toBe(5);
  });

  it("allows JOB_MAX_RETRIES of 0 (no retries)", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("JOB_MAX_RETRIES", "0");

    const { env } = await import("./env.js");
    expect(env.JOB_MAX_RETRIES).toBe(0);
  });

  it("uses default JOB_BACKOFF_MS of 30000", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    const { env } = await import("./env.js");
    expect(env.JOB_BACKOFF_MS).toBe(30000);
  });

  it("throws when JOB_BACKOFF_MS is not a positive integer", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("JOB_BACKOFF_MS", "0");

    await expect(import("./env.js")).rejects.toThrow();
  });

  it("requires CLAUDE_CODE_OAUTH_TOKEN", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

    await expect(import("./env.js")).rejects.toThrow();
  });

  it("allows optional SLACK_BOT_TOKEN", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    const { env } = await import("./env.js");
    expect(env.SLACK_BOT_TOKEN).toBeUndefined();
  });

  it("parses SLACK_BOT_TOKEN when set", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test-token");

    const { env } = await import("./env.js");
    expect(env.SLACK_BOT_TOKEN).toBe("xoxb-test-token");
  });

  it("allows optional SLACK_DEFAULT_CHANNEL", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    const { env } = await import("./env.js");
    expect(env.SLACK_DEFAULT_CHANNEL).toBeUndefined();
  });

  it("parses SLACK_DEFAULT_CHANNEL when set", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("SLACK_DEFAULT_CHANNEL", "#blazebot-notifications");

    const { env } = await import("./env.js");
    expect(env.SLACK_DEFAULT_CHANNEL).toBe("#blazebot-notifications");
  });

  it("uses default CLAUDE_MODEL of 'claude-sonnet-4-20250514'", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-test");

    const { env } = await import("./env.js");
    expect(env.CLAUDE_MODEL).toBe("claude-sonnet-4-20250514");
  });

  it("allows overriding CLAUDE_MODEL via env", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-test");
    vi.stubEnv("CLAUDE_MODEL", "claude-opus-4-20250514");

    const { env } = await import("./env.js");
    expect(env.CLAUDE_MODEL).toBe("claude-opus-4-20250514");
  });
});
