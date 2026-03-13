import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ioredis", () => ({ Redis: vi.fn() }));
vi.mock("bullmq", () => ({ Queue: vi.fn() }));

describe("ticketQueue", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("JIRA_WEBHOOK_SECRET", "test-secret");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-test");
  });

  it("creates a queue named 'ticket'", async () => {
    const bullmq = await import("bullmq");
    await import("./queue.js");

    expect(bullmq.Queue).toHaveBeenCalledWith(
      "ticket",
      expect.objectContaining({ connection: expect.anything() }),
    );
  });
});
