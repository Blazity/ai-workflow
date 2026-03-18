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

  it("configures default job options with retry attempts and exponential backoff", async () => {
    const bullmq = await import("bullmq");
    await import("./queue.js");

    expect(bullmq.Queue).toHaveBeenCalledWith(
      "ticket",
      expect.objectContaining({
        defaultJobOptions: expect.objectContaining({
          attempts: 4,
          backoff: { type: "exponential", delay: 30000 },
        }),
      }),
    );
  });

  it("uses custom retry config from env", async () => {
    vi.stubEnv("JOB_MAX_RETRIES", "5");
    vi.stubEnv("JOB_BACKOFF_MS", "10000");

    const bullmq = await import("bullmq");
    await import("./queue.js");

    expect(bullmq.Queue).toHaveBeenCalledWith(
      "ticket",
      expect.objectContaining({
        defaultJobOptions: expect.objectContaining({
          attempts: 6,
          backoff: { type: "exponential", delay: 10000 },
        }),
      }),
    );
  });
});
