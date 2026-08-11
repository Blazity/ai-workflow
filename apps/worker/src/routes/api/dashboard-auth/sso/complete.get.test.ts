import { createApp, eventHandler, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  getSession: vi.fn(),
  createHandoff: vi.fn(),
  env: {
    BETTER_AUTH_URL: "https://worker.example.com",
    DASHBOARD_ORIGIN: "https://dashboard.example.com",
    DASHBOARD_ORG_SLUG: "ai-workflow",
  },
}));

vi.mock("../../../../../env.js", () => ({ env: state.env }));
vi.mock("../../../../auth-instance.js", () => ({
  auth: { api: { getSession: state.getSession } },
}));
vi.mock("../../../../db/client.js", () => ({ getDb: vi.fn() }));
vi.mock("../../../../lib/auth/invite-acceptance.js", () => ({
  acceptDashboardSsoInvite: vi.fn(),
}));
vi.mock("../../../../lib/auth/sso-handoff.js", () => ({
  createDashboardSsoHandoff: state.createHandoff,
}));

const completeRoute = (await import("./complete.get.js")).default;

beforeEach(() => {
  vi.clearAllMocks();
  state.getSession.mockResolvedValue({
    user: { id: "user_1", email: "user@example.com" },
    session: { token: "session-token" },
  });
  state.createHandoff.mockResolvedValue("handoff-token");
});

function handlerFor(route: Parameters<typeof eventHandler>[0]) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app);
}

describe("SSO completion", () => {
  it("resumes a validated OAuth request on the worker origin", async () => {
    const returnTo = "/api/auth/oauth2/authorize?client_id=client_1&state=opaque";
    const res = await handlerFor(completeRoute)(
      new Request(`http://localhost/?returnTo=${encodeURIComponent(returnTo)}`),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`https://worker.example.com${returnTo}`);
    expect(state.createHandoff).not.toHaveBeenCalled();
  });

  it("keeps the existing dashboard handoff when returnTo is absent", async () => {
    const res = await handlerFor(completeRoute)(new Request("http://localhost/"));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://dashboard.example.com/api/auth/sso/complete?token=handoff-token",
    );
    expect(state.createHandoff).toHaveBeenCalledWith(expect.anything(), "session-token");
  });

  it("drops unsafe returnTo and keeps the existing dashboard handoff", async () => {
    const res = await handlerFor(completeRoute)(
      new Request("http://localhost/?returnTo=https%3A%2F%2Fevil.example%2Fsteal"),
    );

    expect(res.headers.get("location")).toBe(
      "https://dashboard.example.com/api/auth/sso/complete?token=handoff-token",
    );
  });
});
