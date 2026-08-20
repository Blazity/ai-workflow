import { createError, createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemHealthResponse } from "@shared/contracts";

const state = vi.hoisted(() => ({
  role: "admin" as "owner" | "admin" | "member" | null,
  collect: vi.fn(),
}));

vi.mock("../../../../lib/auth/request-context.js", () => ({
  requireDashboardActor: vi.fn(async () => {
    if (state.role === null) {
      throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
    }
    return { role: state.role };
  }),
  toHttpError: (error: unknown) => {
    throw error;
  },
}));
vi.mock("../../../../system-health/probes.js", () => ({
  collectDeploymentSystemHealth: state.collect,
}));

const route = (await import("./health.get.js")).default;

const fixture: SystemHealthResponse = {
  generatedAt: "2026-08-20T12:00:00.000Z",
  summary: {
    total: 1,
    live: 1,
    down: 0,
    notConfigured: 0,
    criticalDown: 0,
  },
  integrations: [
    {
      id: "database",
      label: "Database",
      group: "core",
      envVars: ["DATABASE_URL"],
      critical: true,
      mode: "live",
      ping: { ok: true, latencyMs: 12 },
    },
  ],
  alerts: [],
};

function request() {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app)(new Request("http://worker.test/"));
}

beforeEach(() => {
  state.role = "admin";
  state.collect.mockReset().mockResolvedValue(fixture);
});

describe("GET /api/v1/system/health", () => {
  it("requires a dashboard session", async () => {
    state.role = null;
    expect((await request()).status).toBe(401);
  });

  it("keeps deployment diagnostics restricted to owner and admin roles", async () => {
    state.role = "member";
    expect((await request()).status).toBe(403);
    expect(state.collect).not.toHaveBeenCalled();
  });

  it("returns fresh diagnostics without caching", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(fixture);
    expect(state.collect).toHaveBeenCalledOnce();
  });
});
