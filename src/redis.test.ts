import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ioredis", () => {
  return { Redis: vi.fn() };
});

describe("createRedisConnection", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("JIRA_WEBHOOK_SECRET", "test-secret");
  });

  it("creates an IORedis instance with the correct URL and config", async () => {
    const ioredis = await import("ioredis");
    const { createRedisConnection } = await import("./redis.js");

    createRedisConnection();

    expect(ioredis.Redis).toHaveBeenCalledWith("redis://localhost:6379", {
      maxRetriesPerRequest: null,
    });
  });

  it("returns a new instance on each call", async () => {
    const { createRedisConnection } = await import("./redis.js");

    const conn1 = createRedisConnection();
    const conn2 = createRedisConnection();

    expect(conn1).not.toBe(conn2);
  });
});
