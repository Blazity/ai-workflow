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
  });

  it("uses default NODE_ENV of development", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    delete process.env.NODE_ENV;

    const { env } = await import("./env.js");
    expect(env.NODE_ENV).toBe("development");
  });

  it("uses default COLUMN_AI of 'AI'", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");

    const { env } = await import("./env.js");
    expect(env.COLUMN_AI).toBe("AI");
  });

  it("allows overriding column names via env", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("COLUMN_AI", "Custom AI");

    const { env } = await import("./env.js");
    expect(env.COLUMN_AI).toBe("Custom AI");
  });

  it("uses default ISSUE_TRACKER_KIND of 'jira'", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");

    const { env } = await import("./env.js");
    expect(env.ISSUE_TRACKER_KIND).toBe("jira");
  });

  it("uses default MESSAGING_KIND of 'slack'", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");

    const { env } = await import("./env.js");
    expect(env.MESSAGING_KIND).toBe("slack");
  });

  it("uses default VCS_KIND of 'github'", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");

    const { env } = await import("./env.js");
    expect(env.VCS_KIND).toBe("github");
  });

  it("uses default COLUMN_AI_REVIEW of 'AI Review'", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");

    const { env } = await import("./env.js");
    expect(env.COLUMN_AI_REVIEW).toBe("AI Review");
  });

  it("uses default COLUMN_BACKLOG of 'Backlog'", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");

    const { env } = await import("./env.js");
    expect(env.COLUMN_BACKLOG).toBe("Backlog");
  });

  it("allows optional SLACK_BOT_TOKEN", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");

    const { env } = await import("./env.js");
    expect(env.SLACK_BOT_TOKEN).toBeUndefined();
  });

  it("parses SLACK_BOT_TOKEN when set", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test-token");

    const { env } = await import("./env.js");
    expect(env.SLACK_BOT_TOKEN).toBe("xoxb-test-token");
  });

  it("allows optional SLACK_DEFAULT_CHANNEL", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");

    const { env } = await import("./env.js");
    expect(env.SLACK_DEFAULT_CHANNEL).toBeUndefined();
  });

  it("parses SLACK_DEFAULT_CHANNEL when set", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("SLACK_DEFAULT_CHANNEL", "#blazebot-notifications");

    const { env } = await import("./env.js");
    expect(env.SLACK_DEFAULT_CHANNEL).toBe("#blazebot-notifications");
  });
});
