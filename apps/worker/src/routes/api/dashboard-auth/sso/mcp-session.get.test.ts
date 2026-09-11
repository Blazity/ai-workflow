import { createApp, eventHandler, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  generateOneTimeToken: vi.fn(),
}));

vi.mock("../../../../auth-instance.js", () => ({
  auth: { api: { generateOneTimeToken: state.generateOneTimeToken } },
}));

const bridgeRoute = (await import("./mcp-session.get.js")).default;

function handlerFor(route: Parameters<typeof eventHandler>[0]) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.generateOneTimeToken.mockResolvedValue({ token: "opaque-handoff-token-123456" });
});

describe("dashboard MCP session bridge", () => {
  it("turns the dashboard bearer session into an opaque one-time token", async () => {
    const rawSession = "raw-dashboard-session-token";
    const response = await handlerFor(bridgeRoute)(
      new Request("https://worker.example.com/api/dashboard-auth/sso/mcp-session", {
        headers: { authorization: `Bearer ${rawSession}` },
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ token: "opaque-handoff-token-123456" });
    expect(state.generateOneTimeToken).toHaveBeenCalledWith({
      headers: expect.any(Headers),
    });
    expect(state.generateOneTimeToken.mock.calls[0]?.[0].headers.get("authorization")).toBe(
      `Bearer ${rawSession}`,
    );
    expect(JSON.stringify(body)).not.toContain(rawSession);
  });

  it("rejects missing, expired, or invalid dashboard sessions", async () => {
    state.generateOneTimeToken.mockRejectedValue(new Error("Unauthorized"));

    const response = await handlerFor(bridgeRoute)(
      new Request("https://worker.example.com/api/dashboard-auth/sso/mcp-session"),
    );

    expect(response.status).toBe(401);
    expect(state.generateOneTimeToken).toHaveBeenCalledOnce();
  });

  it("rejects a malformed token returned by the auth provider", async () => {
    state.generateOneTimeToken.mockResolvedValue({ token: "raw.session.token" });

    const response = await handlerFor(bridgeRoute)(
      new Request("https://worker.example.com/api/dashboard-auth/sso/mcp-session", {
        headers: { authorization: "Bearer valid-session" },
      }),
    );

    expect(response.status).toBe(401);
  });
});
