import { describe, it, expect, vi, beforeEach } from "vitest";

describe("env", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
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

  it("throws when MAX_CONCURRENT_CONTAINERS is not a positive integer", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("MAX_CONCURRENT_CONTAINERS", "0");

    await expect(import("./env.js")).rejects.toThrow();
  });

  it("uses default PORT of 3000", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    const { env } = await import("./env.js");
    expect(env.PORT).toBe(3000);
  });

  it("uses default MAX_CONCURRENT_CONTAINERS of 3", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    const { env } = await import("./env.js");
    expect(env.MAX_CONCURRENT_CONTAINERS).toBe(3);
  });

  it("parses MAX_CONCURRENT_CONTAINERS as integer", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("MAX_CONCURRENT_CONTAINERS", "5");

    const { env } = await import("./env.js");
    expect(env.MAX_CONCURRENT_CONTAINERS).toBe(5);
  });

  it("uses default NODE_ENV of development", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    delete process.env.NODE_ENV;

    const { env } = await import("./env.js");
    expect(env.NODE_ENV).toBe("development");
  });
});
