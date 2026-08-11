import { describe, expect, it } from "vitest";

import {
  createOAuthFlowCookie,
  readOAuthFlowCookie,
  renderMcpConsentPage,
  renderMcpLoginPage,
  isSameOriginPost,
  safeOAuthReturnPath,
} from "./auth-pages.js";

const SECRET = "s".repeat(32);

describe("MCP auth pages", () => {
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
    });

    expect(html).toContain("Agent &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("callback.example.com");
    expect(html).toContain("mcp:read");
    expect(html).toContain("runs:dispatch");
    expect(html).not.toContain("unknown");
    expect(html).not.toContain("oauth_query");
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
