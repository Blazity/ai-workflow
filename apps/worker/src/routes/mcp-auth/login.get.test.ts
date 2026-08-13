import { createApp, eventHandler, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  getSession: vi.fn(),
  verifyOneTimeToken: vi.fn(),
  env: {
    BETTER_AUTH_SECRET: "test-secret",
    BETTER_AUTH_URL: "https://worker.example.com",
    DASHBOARD_ORIGIN: "https://dashboard.example.com",
  },
}));

vi.mock("../../../env.js", () => ({ env: state.env }));
vi.mock("../../auth-instance.js", () => ({
  auth: {
    api: {
      getSession: state.getSession,
      verifyOneTimeToken: state.verifyOneTimeToken,
    },
  },
}));

const loginRoute = (await import("./login.get.js")).default;

function handlerFor(route: Parameters<typeof eventHandler>[0]) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app);
}

function oauthUrl(): string {
  return "https://worker.example.com/mcp-auth/login?response_type=code&client_id=client_1&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&scope=mcp%3Aread";
}

beforeEach(() => {
  vi.clearAllMocks();
  state.getSession.mockResolvedValue(null);
  state.verifyOneTimeToken.mockResolvedValue({
    headers: new Headers({ "set-cookie": "__Secure-better-auth.session_token=session-cookie" }),
    response: { session: {}, user: {} },
  });
});

describe("MCP login handoff", () => {
  it("bypasses login for an existing worker session", async () => {
    state.getSession.mockResolvedValue({ session: { token: "worker-session" }, user: {} });

    const response = await handlerFor(loginRoute)(new Request(oauthUrl()));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://worker.example.com/mcp-auth/consent?response_type=code&client_id=client_1&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&scope=mcp%3Aread",
    );
    expect(response.headers.get("set-cookie")).toContain("mcp_oauth=");
  });

  it("bridges a dashboard session without exposing a raw session token", async () => {
    const response = await handlerFor(loginRoute)(new Request(oauthUrl()));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://dashboard.example.com/api/auth/sso/mcp-session",
    );
    expect(response.headers.get("location")).not.toContain("worker-session");
  });

  it("keeps the email/password and SSO fallback available", async () => {
    const response = await handlerFor(loginRoute)(
      new Request("https://worker.example.com/mcp-auth/login?fallback=1"),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('action="/mcp-auth/login"');
    expect(html).toContain("Continue with SSO");
    expect(state.getSession).toHaveBeenCalledOnce();
  });

  it("verifies a single-use opaque handoff and resumes the saved OAuth query", async () => {
    const initial = await handlerFor(loginRoute)(new Request(oauthUrl()));
    const cookie = initial.headers.get("set-cookie")?.split(";", 1)[0];

    const response = await handlerFor(loginRoute)(
      new Request("https://worker.example.com/mcp-auth/login?handoff=opaque-handoff-token-123456", {
        headers: { cookie: cookie ?? "" },
      }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://worker.example.com/mcp-auth/consent?response_type=code&client_id=client_1&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&scope=mcp%3Aread",
    );
    expect(response.headers.get("location")).not.toContain("worker-session");
    expect(state.verifyOneTimeToken).toHaveBeenCalledWith({
      body: { token: "opaque-handoff-token-123456" },
      returnHeaders: true,
    });
    expect(response.headers.get("set-cookie")).toContain("session-cookie");
  });

  it.each([
    ["invalid", "not-a-valid-token"],
    ["expired", "opaque-expired-token-123456"],
    ["replayed", "opaque-replayed-token-123456"],
  ])("rejects %s handoffs", async (_label, token) => {
    state.verifyOneTimeToken.mockRejectedValue(new Error("Invalid token"));
    const initial = await handlerFor(loginRoute)(new Request(oauthUrl()));
    const cookie = initial.headers.get("set-cookie")?.split(";", 1)[0];

    const response = await handlerFor(loginRoute)(
      new Request(`https://worker.example.com/mcp-auth/login?handoff=${token}`, {
        headers: { cookie: cookie ?? "" },
      }),
    );

    expect(response.status).toBe(token === "not-a-valid-token" ? 400 : 401);
    expect(response.headers.get("location")).toBeNull();
  });
});
