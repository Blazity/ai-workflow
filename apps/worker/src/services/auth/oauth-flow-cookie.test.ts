import { describe, expect, it, vi } from "vitest";

// The codec reads the signing secret itself, through the settings accessor, so
// the test supplies it the way the deployment would rather than as an argument.
vi.mock("../../config/env.js", () => ({
  env: {
    BETTER_AUTH_SECRET: "s".repeat(32),
  },
}));

const { createOAuthFlowCookie, readOAuthFlowCookie } = await import(
  "./oauth-flow-cookie.js"
);

describe("OAuth flow cookie", () => {
  it("keeps signed oauth_query state HttpOnly and rejects missing, expired, or tampered state", () => {
    const now = new Date("2026-08-11T12:00:00.000Z");
    const cookie = createOAuthFlowCookie("client_id=abc&sig=opaque", now);

    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(readOAuthFlowCookie(cookie, now)).toBe("client_id=abc&sig=opaque");
    expect(readOAuthFlowCookie(null, now)).toBeNull();
    expect(readOAuthFlowCookie(cookie, new Date(now.getTime() + 11 * 60_000))).toBeNull();
    expect(readOAuthFlowCookie(cookie.replace("mcp_oauth=", "mcp_oauth=x"), now)).toBeNull();
  });
});
