import { describe, it, expect, vi, beforeEach } from "vitest";

describe("env", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("validates when all required env vars are set", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");

    const { env } = await import("./env.js");
    expect(env.DATABASE_URL).toBe("postgresql://user:pass@localhost:5432/db");
    expect(env.REDIS_URL).toBeUndefined();
  });

  it("accepts optional REDIS_URL", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    const { env } = await import("./env.js");
    expect(env.REDIS_URL).toBe("redis://localhost:6379");
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
});
