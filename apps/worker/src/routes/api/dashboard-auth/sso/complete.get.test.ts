import { createApp, eventHandler, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardAuthError } from "../../../../services/auth/users-read.js";

const state = vi.hoisted(() => ({
  getSession: vi.fn(),
  createHandoff: vi.fn(),
  acceptInvite: vi.fn(),
  env: {
    BETTER_AUTH_URL: "https://worker.example.com",
    DASHBOARD_ORIGIN: "https://dashboard.example.com",
    DASHBOARD_ORG_SLUG: "ai-workflow",
  },
}));

vi.mock("../../../../infra/vcs-config.js", () => ({ env: state.env }));
vi.mock("../../../../auth-instance.js", () => ({
  auth: { api: { getSession: state.getSession } },
}));
vi.mock("../../../../services/auth/invite-requests.js", () => ({
  acceptDashboardSsoInviteForUser: state.acceptInvite,
}));
vi.mock("../../../../services/auth/sso-handoff.js", () => ({
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
  state.acceptInvite.mockResolvedValue(undefined);
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

  it("treats a replayed already-accepted invite as the completed SSO flow", async () => {
    const res = await handlerFor(completeRoute)(
      new Request("http://localhost/?inviteId=invite_1"),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://dashboard.example.com/api/auth/sso/complete?token=handoff-token",
    );
    expect(state.acceptInvite).toHaveBeenCalledWith(expect.anything(), {
      inviteId: "invite_1",
      user: { id: "user_1", email: "user@example.com" },
    });
  });

  it("renders a declined invite through the existing password-acceptance error path", async () => {
    state.acceptInvite.mockRejectedValue(new DashboardAuthError(410, "Invite expired"));

    const res = await handlerFor(completeRoute)(
      new Request("http://localhost/?inviteId=invite_1"),
    );

    expect(res.status).toBe(410);
    await expect(res.text()).resolves.toContain("Invite expired");
  });
});
