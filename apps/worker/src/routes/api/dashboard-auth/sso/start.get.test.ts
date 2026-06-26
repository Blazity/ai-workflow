import { createApp, eventHandler, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DASHBOARD_SSO_PROVIDER_ID } from "../../../../auth.js";

const state = vi.hoisted(() => ({
  authHandler: vi.fn(),
  env: {
    BETTER_AUTH_URL: "https://worker.example.com",
    DASHBOARD_ORIGIN: "https://dashboard.example.com",
  },
}));

vi.mock("../../../../../env.js", () => ({
  env: state.env,
}));

vi.mock("../../../../auth-instance.js", () => ({
  auth: {
    handler: state.authHandler,
  },
}));

const startRoute = (await import("./start.get.js")).default;

beforeEach(() => {
  vi.clearAllMocks();
  state.authHandler.mockResolvedValue(
    Response.json({ url: "https://idp.example.com/authorize" }),
  );
});

function handlerFor(route: Parameters<typeof eventHandler>[0]) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app);
}

describe("SSO start API", () => {
  it("starts OIDC SSO against the fixed dashboard provider", async () => {
    const res = await handlerFor(startRoute)(new Request("http://localhost/"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      url: "https://idp.example.com/authorize",
    });

    const request = state.authHandler.mock.calls[0]?.[0] as Request | undefined;
    expect(request?.url).toBe("https://worker.example.com/api/auth/sign-in/sso");
    await expect(request?.json()).resolves.toMatchObject({
      providerId: DASHBOARD_SSO_PROVIDER_ID,
      providerType: "oidc",
      callbackURL: "https://worker.example.com/api/dashboard-auth/sso/complete",
      errorCallbackURL: "https://dashboard.example.com/login",
    });
  });
});
