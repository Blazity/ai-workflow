import { createApp, toWebHandler, type EventHandler } from "h3";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { createAuth } from "../auth.js";
import { organization } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";

const state = vi.hoisted(() => ({
  env: {
    BETTER_AUTH_URL: "https://worker.example.com",
  },
  auth: {} as Record<PropertyKey, unknown>,
}));

vi.mock("../../env.js", () => ({ env: state.env }));
vi.mock("../auth-instance.js", () => ({
  auth: new Proxy({}, {
    get: (_target, property) => {
      const value = state.auth[property];
      return typeof value === "function" ? value.bind(state.auth) : value;
    },
  }),
}));

const protectedResourceRoute = (
  await import("../routes/.well-known/oauth-protected-resource/mcp.get.js")
).default;
const issuerMetadataRoute = (
  await import("../routes/.well-known/oauth-authorization-server/api/auth.get.js")
).default;

beforeAll(async () => {
  const db = await createTestDb();
  await db.insert(organization).values({
    id: "org_fixed",
    name: "AI Workflow",
    slug: "ai-workflow",
  });
  state.auth = createAuth(db, {
    secret: "x".repeat(32),
    baseURL: "https://worker.example.com",
    trustedOrigins: ["https://worker.example.com"],
    mcp: { organizationId: "org_fixed", allowPublicDcr: false },
  }) as unknown as Record<PropertyKey, unknown>;
});

describe("MCP OAuth discovery", () => {
  it("serves exact RFC 9728 protected-resource metadata at the root path", async () => {
    const response = await routeResponse(
      protectedResourceRoute,
      "https://worker.example.com/.well-known/oauth-protected-resource/mcp",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      resource: "https://worker.example.com/mcp",
      authorization_servers: ["https://worker.example.com/api/auth"],
      scopes_supported: ["mcp:read", "runs:dispatch", "prompts:write", "workflows:write"],
    });
  });

  it("forwards the root issuer-path request to the real Better Auth provider", async () => {
    const response = await routeResponse(
      issuerMetadataRoute,
      "https://worker.example.com/.well-known/oauth-authorization-server/api/auth",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      issuer: "https://worker.example.com/api/auth",
      scopes_supported: ["mcp:read", "runs:dispatch", "prompts:write", "workflows:write"],
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: expect.arrayContaining([
        "authorization_code",
        "client_credentials",
        "refresh_token",
      ]),
    });
  });
});

async function routeResponse(handler: EventHandler, url: string) {
  const app = createApp();
  app.use("/", handler);
  return toWebHandler(app)(new Request(url));
}
