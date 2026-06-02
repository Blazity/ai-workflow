import { describe, it, expect, vi } from "vitest";
import { createApp, toWebHandler, eventHandler } from "h3";

const TOKEN = "test-api-token";

// Mock env BEFORE importing the middleware (which reads env at request time).
vi.mock("../../env.js", () => ({
  env: { WORKER_API_TOKEN: TOKEN },
}));

const apiAuth = (await import("./api-auth.js")).default;

/** App with the auth middleware in front of a couple of dummy routes. */
function makeApp() {
  const app = createApp();
  app.use(apiAuth);
  app.use(
    "/api/v1/runs",
    eventHandler(() => ({ ok: true })),
  );
  app.use(
    "/cron/poll",
    eventHandler(() => ({ ok: true })),
  );
  return toWebHandler(app);
}

function get(path: string, headers: Record<string, string> = {}) {
  return makeApp()(new Request(`http://localhost${path}`, { headers }));
}

describe("api-auth middleware", () => {
  it("allows /api/v1/* with a correct bearer token", async () => {
    const res = await get("/api/v1/runs", { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects /api/v1/* with no token (401)", async () => {
    const res = await get("/api/v1/runs");
    expect(res.status).toBe(401);
  });

  it("rejects /api/v1/* with a wrong token (401)", async () => {
    const res = await get("/api/v1/runs", { authorization: "Bearer nope" });
    expect(res.status).toBe(401);
  });

  it("does NOT gate non-/api/v1 paths (cron stays open to its own auth)", async () => {
    const res = await get("/cron/poll");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
