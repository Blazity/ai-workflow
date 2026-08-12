import { describe, expect, it } from "vitest";

import { oauthClient, organization } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { MCP_SCOPES } from "./contracts.js";
import {
  canonicalMcpResource,
  createMcpOAuthOptions,
  validateMcpOAuthHookRequest,
  validateMcpOAuthRequest,
} from "./oauth.js";

const DEPLOYMENT = {
  baseURL: "https://worker.example.com/",
  organizationId: "org_fixed",
  allowPublicDcr: false,
};

describe("MCP OAuth provider options", () => {
  it("canonicalizes the protected resource", () => {
    expect(canonicalMcpResource("https://worker.example.com/")).toBe(
      "https://worker.example.com/mcp",
    );
  });

  it("advertises the exact scopes, S256, and supported grants", () => {
    const options = createMcpOAuthOptions(DEPLOYMENT);

    expect(options.scopes).toEqual(MCP_SCOPES);
    expect(options.validAudiences).toEqual(["https://worker.example.com/mcp"]);
    expect(options.grantTypes).toEqual(
      expect.arrayContaining(["authorization_code", "client_credentials", "refresh_token"]),
    );
    expect(options.codeChallengeMethodsSupported).toContain("S256");
    expect(options.silenceWarnings).toEqual({ oauthAuthServerConfig: true });
  });

  it("keeps unauthenticated DCR disabled by default", () => {
    const options = createMcpOAuthOptions(DEPLOYMENT);

    expect(options.allowDynamicClientRegistration).toBe(true);
    expect(options.allowUnauthenticatedClientRegistration).toBe(false);
  });

  it("enables unauthenticated DCR only through the deployment flag", () => {
    const options = createMcpOAuthOptions({ ...DEPLOYMENT, allowPublicDcr: true });

    expect(options.allowUnauthenticatedClientRegistration).toBe(true);
  });

  it.each([
    [{ token_endpoint_auth_method: "client_secret_post", redirect_uris: ["https://client.example/cb"] }],
    [{ token_endpoint_auth_method: "none", redirect_uris: ["http://client.example/cb"] }],
    [{ token_endpoint_auth_method: "none", redirect_uris: ["https://user:pass@client.example/cb"] }],
    [{ token_endpoint_auth_method: "none", redirect_uris: ["https://client.example/cb#fragment"] }],
  ])("rejects unsafe public registration metadata", (body) => {
    expect(() =>
      validateMcpOAuthRequest({ path: "/oauth2/register", body, allowPublicDcr: true }),
    ).toThrow("Invalid OAuth client registration");
  });

  it.each([
    "https://client.example/callback",
    "http://localhost:43110/callback",
    "http://127.0.0.1:43110/callback",
    "http://[::1]:43110/callback",
  ])("accepts a public S256-capable client redirect at %s", (redirectUri) => {
    expect(() =>
      validateMcpOAuthRequest({
        path: "/oauth2/register",
        body: {
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          redirect_uris: [redirectUri],
        },
        allowPublicDcr: true,
      }),
    ).not.toThrow();
  });

  it("binds client ownership to the fixed active organization", async () => {
    const options = createMcpOAuthOptions(DEPLOYMENT);

    await expect(
      options.clientReference?.({ session: { activeOrganizationId: "org_fixed" } as never }),
    ).resolves.toBe("org_fixed");
    await expect(
      options.clientReference?.({ session: { activeOrganizationId: "org_other" } as never }),
    ).rejects.toThrow("OAuth client organization is not active");
  });

  it("rejects service credentials without the fixed reference and allowlisted scopes", () => {
    expect(() =>
      validateMcpOAuthRequest({
        path: "/oauth2/token",
        body: { grant_type: "client_credentials", client_id: "service-client" },
        allowPublicDcr: false,
        serviceClient: {
          referenceId: null,
          scopes: ["mcp:read"],
        },
        organizationId: "org_fixed",
      }),
    ).toThrow("OAuth service client is not authorized");

    expect(() =>
      validateMcpOAuthRequest({
        path: "/oauth2/token",
        body: { grant_type: "client_credentials", client_id: "service-client" },
        allowPublicDcr: false,
        serviceClient: {
          referenceId: "org_fixed",
          scopes: ["admin:all"],
        },
        organizationId: "org_fixed",
      }),
    ).toThrow("OAuth service client is not authorized");
  });

  it("rejects conflicting Basic and body client identities using Basic precedence", async () => {
    const db = await serviceClientDb();

    await expect(
      validateMcpOAuthHookRequest(
        db,
        { ...DEPLOYMENT, db },
        "/oauth2/token",
        { grant_type: "client_credentials", client_id: "approved-client" },
        basicAuthorization("wrong-reference-client"),
      ),
    ).rejects.toThrow("OAuth client request rejected");
  });

  it("rejects malformed Basic credentials even when the body client is approved", async () => {
    const db = await serviceClientDb();

    await expect(
      validateMcpOAuthHookRequest(
        db,
        { ...DEPLOYMENT, db },
        "/oauth2/token",
        { grant_type: "client_credentials", client_id: "approved-client" },
        "Basic !!!",
      ),
    ).rejects.toThrow("OAuth client request rejected");
  });

  it("accepts matching Basic and body client identities", async () => {
    const db = await serviceClientDb();

    await expect(
      validateMcpOAuthHookRequest(
        db,
        { ...DEPLOYMENT, db },
        "/oauth2/token",
        { grant_type: "client_credentials", client_id: "approved-client" },
        basicAuthorization("approved-client"),
      ),
    ).resolves.toBeUndefined();
  });
});

async function serviceClientDb() {
  const db = await createTestDb();
  await db.insert(organization).values({
    id: "org_fixed",
    name: "AI Workflow",
    slug: "ai-workflow",
  });
  await db.insert(oauthClient).values([
    {
      id: "oauth_approved",
      clientId: "approved-client",
      redirectUris: [],
      scopes: ["mcp:read"],
      referenceId: "org_fixed",
    },
    {
      id: "oauth_wrong_reference",
      clientId: "wrong-reference-client",
      redirectUris: [],
      scopes: ["mcp:read"],
      referenceId: "org_other",
    },
  ]);
  return db;
}

function basicAuthorization(clientId: string): string {
  return `Basic ${Buffer.from(`${clientId}:secret`).toString("base64")}`;
}
