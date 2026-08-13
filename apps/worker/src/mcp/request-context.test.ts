import { beforeEach, describe, expect, it, vi } from "vitest";
import { oauthClient, member, organization, user } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import type { Db } from "../db/client.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  verifyAccessToken: vi.fn(),
}));

vi.mock("../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../env.js", () => ({
  env: {
    BETTER_AUTH_URL: "https://worker.example.com",
    DASHBOARD_ORG_SLUG: "ai-workflow",
  },
}));
vi.mock("@better-auth/oauth-provider/resource-client", () => ({
  oauthProviderResourceClient: () => ({
    getActions: () => ({ verifyAccessToken: state.verifyAccessToken }),
  }),
}));
vi.mock("../auth-instance.js", () => ({ auth: {} }));

const { requireMcpActor } = await import("./request-context.js");

let db: Db;

beforeEach(async () => {
  vi.clearAllMocks();
  db = await createTestDb();
  state.db = db;
  await db.insert(organization).values({ id: "org_fixed", name: "AI Workflow", slug: "ai-workflow" });
  await db.insert(user).values({ id: "user_1", name: "User", email: "u@example.com", emailVerified: true });
  await db.insert(member).values({ id: "member_1", organizationId: "org_fixed", userId: "user_1", role: "member" });
  await db.insert(oauthClient).values({
    id: "oauth_1",
    clientId: "client_1",
    redirectUris: ["https://client.example/callback"],
    scopes: ["mcp:read", "runs:dispatch"],
    referenceId: "org_fixed",
  });
});

function request(authorization = "Bearer access-token") {
  return new Request("https://worker.example.com/mcp", { headers: { authorization } });
}

function userClaims(overrides: Record<string, unknown> = {}) {
  return {
    iss: "https://worker.example.com/api/auth",
    aud: "https://worker.example.com/mcp",
    sub: "user_1",
    azp: "client_1",
    scope: "mcp:read runs:dispatch",
    organization_id: "org_fixed",
    organization_role: "member",
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  };
}

describe("requireMcpActor", () => {
  it("builds a fixed-organization member context and intersects client scopes", async () => {
    state.verifyAccessToken.mockResolvedValue(userClaims());

    await expect(requireMcpActor(request())).resolves.toEqual({
      kind: "user",
      subject: "user_1",
      userId: "user_1",
      clientId: "client_1",
      organizationId: "org_fixed",
      organizationSlug: "ai-workflow",
      role: "member",
      scopes: new Set(["mcp:read", "runs:dispatch"]),
      audience: "https://worker.example.com/mcp",
    });
    expect(state.verifyAccessToken).toHaveBeenCalledWith("access-token", {
      jwksUrl: "https://worker.example.com/api/auth/jwks",
      verifyOptions: {
        issuer: "https://worker.example.com/api/auth",
        audience: "https://worker.example.com/mcp",
      },
    });
  });

  it("normalizes an admin membership instead of trusting the token role", async () => {
    await db.update(member).set({ role: "admin" });
    state.verifyAccessToken.mockResolvedValue(userClaims({ organization_role: "member" }));

    await expect(requireMcpActor(request())).resolves.toMatchObject({ role: "admin" });
  });

  it.each([
    ["wrong audience", userClaims({ aud: "https://worker.example.com/other" }), "UNAUTHENTICATED"],
    ["token organization differs", userClaims({ organization_id: "org_other" }), "FORBIDDEN"],
    ["missing scope", userClaims({ scope: "unknown" }), "INSUFFICIENT_SCOPE"],
  ])("rejects %s", async (_name, claims, code) => {
    state.verifyAccessToken.mockResolvedValue(claims);
    await expect(requireMcpActor(request())).rejects.toMatchObject({ code });
  });

  it("rejects expired or invalid tokens without leaking verifier details", async () => {
    state.verifyAccessToken.mockRejectedValue(new Error("JWT expired: raw-token-detail"));

    const error = await requireMcpActor(request()).catch((value) => value as Error);
    if (!(error instanceof Error)) throw new Error("expected authentication error");
    expect(error).toMatchObject({ code: "UNAUTHENTICATED", message: "Authentication required" });
    expect(error.message).not.toContain("raw-token-detail");
  });

  it("rejects subjects outside the deployment organization", async () => {
    await db.delete(member);
    state.verifyAccessToken.mockResolvedValue(userClaims());

    await expect(requireMcpActor(request())).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("builds a service context only for a fixed-reference client", async () => {
    state.verifyAccessToken.mockResolvedValue(userClaims({
      sub: undefined,
      organization_role: "service",
      scope: "mcp:read",
    }));

    await expect(requireMcpActor(request())).resolves.toMatchObject({
      kind: "service",
      subject: "client_1",
      userId: null,
      role: "service",
      scopes: new Set(["mcp:read"]),
    });
  });

  it.each(["", "Basic abc", "Bearer one Bearer two", "Bearer one, Bearer two"])(
    "requires exactly one Bearer token: %j",
    async (authorization) => {
      await expect(requireMcpActor(request(authorization))).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
      });
      expect(state.verifyAccessToken).not.toHaveBeenCalled();
    },
  );
});
