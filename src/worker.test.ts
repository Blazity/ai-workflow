import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ioredis", () => ({ Redis: vi.fn() }));
vi.mock("bullmq", () => ({ Worker: vi.fn() }));

describe("createWorker", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  });

  it("creates a worker on the 'ticket' queue", async () => {
    const bullmq = await import("bullmq");
    const { createWorker } = await import("./worker.js");

    createWorker();

    expect(bullmq.Worker).toHaveBeenCalledWith(
      "ticket",
      expect.any(Function),
      expect.objectContaining({ connection: expect.anything() }),
    );
  });
});
