import { createApp, eventHandler, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routeState = vi.hoisted(() => ({
  getOAuthClientPublicPrelogin: vi.fn(),
  oauth2Consent: vi.fn(),
}));

vi.mock("../../env.js", () => ({
  env: {
    BETTER_AUTH_SECRET: "s".repeat(32),
    BETTER_AUTH_URL: "https://worker.example.com",
  },
}));

vi.mock("../auth-instance.js", () => ({
  auth: {
    api: {
      getOAuthClientPublicPrelogin: routeState.getOAuthClientPublicPrelogin,
      oauth2Consent: routeState.oauth2Consent,
    },
  },
}));

import {
  createOAuthFlowCookie,
  isOAuthAuthorizationQuery,
  isOpaqueHandoffToken,
  oauthConsentUrl,
  readOAuthFlowCookie,
  renderMcpConsentPage,
  renderMcpLoginPage,
  isSameOriginPost,
  safeOAuthReturnPath,
} from "./auth-pages.js";

const consentGetRoute = (await import("../routes/mcp-auth/consent.get.js")).default;
const consentPostRoute = (await import("../routes/mcp-auth/consent.post.js")).default;

const SECRET = "s".repeat(32);

beforeEach(() => {
  vi.clearAllMocks();
  routeState.getOAuthClientPublicPrelogin.mockImplementation(
    async ({ body }: { body: { client_id: string } }) => ({
      client_id: body.client_id,
      client_name: body.client_id,
      redirect_uris: [`https://${body.client_id}.example/callback`],
    }),
  );
  routeState.oauth2Consent.mockResolvedValue({
    redirect: true,
    url: "https://client.example/callback?code=issued",
  });
});

function handlerFor(route: Parameters<typeof eventHandler>[0]) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app);
}

describe("MCP auth pages", () => {
  it("recognizes OAuth authorization queries and keeps handoffs opaque", () => {
    expect(
      isOAuthAuthorizationQuery(
        new URLSearchParams({
          response_type: "code",
          client_id: "client",
          redirect_uri: "https://client.example/callback",
        }),
      ),
    ).toBe(true);
    expect(isOpaqueHandoffToken("opaque-handoff-token-123456")).toBe(true);
    expect(isOpaqueHandoffToken("raw.session.token")).toBe(false);
    expect(oauthConsentUrl("client_id=client&redirect_uri=https%3A%2F%2Fclient.example", "https://worker.example.com")).toBe(
      "https://worker.example.com/mcp-auth/consent?client_id=client&redirect_uri=https%3A%2F%2Fclient.example",
    );
  });

  it("escapes client-controlled login errors", () => {
    const html = renderMcpLoginPage({ error: '<img src=x onerror="alert(1)">' });

    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("<img");
  });

  it("renders exact escaped client metadata, hostname, and allowlisted scopes", () => {
    const html = renderMcpConsentPage({
      clientName: "Agent <script>alert(1)</script>",
      redirectUri: "https://callback.example.com/oauth/callback",
      requestedScopes: ["mcp:read", "unknown", "runs:dispatch"],
      flowId: "flow-safe",
    });

    expect(html).toContain("Agent &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("callback.example.com");
    expect(html).toContain("mcp:read");
    expect(html).toContain("runs:dispatch");
    expect(html).not.toContain("unknown");
    expect(html).not.toContain("oauth_query");
  });

  it("shows offline_access with an honest refresh-token description and keeps it in the posted scope", () => {
    const html = renderMcpConsentPage({
      clientName: "Agent",
      redirectUri: "https://callback.example.com/oauth/callback",
      requestedScopes: ["mcp:read", "offline_access"],
      flowId: "flow-safe",
    });

    expect(html).toContain("offline_access");
    expect(html).toContain("Stay signed in");
    expect(html).toContain("not access to any of your data");
    // The hidden field the browser posts back must carry offline_access, or the
    // provider never issues a refresh token.
    expect(html).toContain('name="scope" value="mcp:read offline_access"');
  });

  it("omits the refresh-token description when offline_access is not requested", () => {
    const html = renderMcpConsentPage({
      clientName: "Agent",
      redirectUri: "https://callback.example.com/oauth/callback",
      requestedScopes: ["mcp:read", "runs:dispatch"],
      flowId: "flow-safe",
    });

    expect(html).not.toContain("offline_access");
    expect(html).not.toContain("Stay signed in");
    expect(html).toContain('name="scope" value="mcp:read runs:dispatch"');
  });

  it("keeps signed oauth_query state HttpOnly and rejects missing, expired, or tampered state", () => {
    const now = new Date("2026-08-11T12:00:00.000Z");
    const cookie = createOAuthFlowCookie("client_id=abc&sig=opaque", SECRET, now);

    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(readOAuthFlowCookie(cookie, SECRET, now)).toBe("client_id=abc&sig=opaque");
    expect(readOAuthFlowCookie(null, SECRET, now)).toBeNull();
    expect(readOAuthFlowCookie(cookie, SECRET, new Date(now.getTime() + 11 * 60_000))).toBeNull();
    expect(readOAuthFlowCookie(cookie.replace("mcp_oauth=", "mcp_oauth=x"), SECRET, now)).toBeNull();
  });

  it("accepts auth POSTs only from the configured worker origin", () => {
    expect(
      isSameOriginPost(
        new Request("https://worker.example.com/mcp-auth/consent", {
          method: "POST",
          headers: { origin: "https://worker.example.com" },
        }),
        "https://worker.example.com",
      ),
    ).toBe(true);
    expect(
      isSameOriginPost(
        new Request("https://worker.example.com/mcp-auth/consent", {
          method: "POST",
          headers: { origin: "https://evil.example" },
        }),
        "https://worker.example.com",
      ),
    ).toBe(false);
  });

  it("rejects a stale consent form after another flow replaces its cookie", async () => {
    const getHandler = handlerFor(consentGetRoute);
    const postHandler = handlerFor(consentPostRoute);
    const queryA = new URLSearchParams({
      client_id: "client-a",
      redirect_uri: "https://client-a.example/callback",
      scope: "mcp:read",
      sig: "signed-a",
    });
    const queryB = new URLSearchParams({
      client_id: "client-b",
      redirect_uri: "https://client-b.example/callback",
      scope: "mcp:read",
      sig: "signed-b",
    });

    const pageA = await getHandler(
      new Request(`https://worker.example.com/?${queryA}`),
    );
    const htmlA = await pageA.text();
    const flowA = /name="flow_id" value="([^"]+)"/.exec(htmlA)?.[1];
    expect(flowA).toBeTruthy();

    const pageB = await getHandler(
      new Request(`https://worker.example.com/?${queryB}`),
    );
    const cookieB = pageB.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookieB).toBeTruthy();

    const response = await postHandler(
      new Request("https://worker.example.com/", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: cookieB ?? "",
          origin: "https://worker.example.com",
        },
        body: new URLSearchParams({
          accept: "true",
          scope: "mcp:read",
          flow_id: flowA ?? "",
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(routeState.oauth2Consent).not.toHaveBeenCalled();
  });
});

describe("safeOAuthReturnPath", () => {
  it("accepts only the OAuth authorize resume path", () => {
    expect(
      safeOAuthReturnPath("/api/auth/oauth2/authorize?client_id=client&state=opaque"),
    ).toBe("/api/auth/oauth2/authorize?client_id=client&state=opaque");
    expect(
      safeOAuthReturnPath(
        "/api/auth/oauth2/authorize?client_id=client&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback",
      ),
    ).toBe(
      "/api/auth/oauth2/authorize?client_id=client&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback",
    );
  });

  it.each([
    "https://evil.example/api/auth/oauth2/authorize?client_id=x",
    "//evil.example/api/auth/oauth2/authorize?client_id=x",
    "/api/auth/oauth2/%2e%2e/authorize?client_id=x",
    "/api/auth/get-session?returnTo=x",
    "/mcp-auth/login",
    "/api/auth/oauth2/authorize",
    42,
    null,
  ])("rejects non-OAuth or unsafe resume value %j", (value) => {
    expect(safeOAuthReturnPath(value)).toBeNull();
  });
});
