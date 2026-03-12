import { describe, it, expect, vi, beforeEach } from "vitest";

describe("GET /health", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("PORT", "0");
  });

  it("returns status ok", async () => {
    const { buildApp } = await import("./index.js");
    const app = buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });

    await app.close();
  });
});
