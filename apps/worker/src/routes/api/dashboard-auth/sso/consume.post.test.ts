import { createApp, eventHandler, toWebHandler } from "h3";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  consume: vi.fn(),
}));

vi.mock("../../../../auth-instance.js", () => ({
  auth: {},
}));

vi.mock("../../../../lib/auth/sso-handoff.js", () => ({
  consumeDashboardSsoHandoff: state.consume,
}));

vi.mock("../../../../lib/auth/request-context.js", () => ({
  toHttpError: (error: unknown) => {
    throw error;
  },
}));

const consumeRoute = (await import("./consume.post.js")).default;

function handlerFor(route: Parameters<typeof eventHandler>[0]) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app);
}

describe("SSO consume API", () => {
  it("returns 400 when the body is missing", async () => {
    const res = await handlerFor(consumeRoute)(
      new Request("http://localhost/", { method: "POST" }),
    );

    expect(res.status).toBe(400);
    expect(state.consume).not.toHaveBeenCalled();
  });

  it("returns 400 when the token is not a string", async () => {
    const res = await handlerFor(consumeRoute)(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: 123 }),
      }),
    );

    expect(res.status).toBe(400);
    expect(state.consume).not.toHaveBeenCalled();
  });

  it("returns 400 when the token is blank after trimming", async () => {
    const res = await handlerFor(consumeRoute)(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "   " }),
      }),
    );

    expect(res.status).toBe(400);
    expect(state.consume).not.toHaveBeenCalled();
  });
});
