import { describe, expect, it } from "vitest";
import { encodeBasicCredentials } from "@better-auth/core/oauth2";

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

  it("uses the explicit Better Auth 1.7 resource rollback contract", () => {
    const options = createMcpOAuthOptions(DEPLOYMENT);

    expect(options.resources).toEqual(["https://worker.example.com/mcp"]);
    expect(options.resourceSeedMode).toBe("insertOnly");
    expect(options.enforcePerClientResources).toBe(false);
    expect(options.storeTokens).toBe("hashed");
    expect(options.dpop).toEqual({ signingAlgorithms: [] });
    expect(options.clientRegistrationDefaultResources).toEqual([
      "https://worker.example.com/mcp",
    ]);
  });

  it("advertises the exact scopes and supported grants without removed 1.6 options", () => {
    const options = createMcpOAuthOptions(DEPLOYMENT);

    expect(options.scopes).toEqual([...MCP_SCOPES, "offline_access"]);
    expect(options.grantTypes).toEqual(
      expect.arrayContaining(["authorization_code", "client_credentials", "refresh_token"]),
    );
    for (const removedOption of [
      "validAudiences",
      "clientCredentialGrantDefaultScopes",
      "codeChallengeMethodsSupported",
      "silenceWarnings",
    ]) {
      expect(options).not.toHaveProperty(removedOption);
    }
  });

  it("treats offline_access as a DCR capability, not an implicit refresh grant", () => {
    const options = createMcpOAuthOptions(DEPLOYMENT);

    // Better Auth 1.7 persists the union of these two lists. That makes
    // offline_access a client capability, while refresh issuance still requires an
    // explicit authorization request and consent for the scope.
    expect(options.scopes).toContain("offline_access");
    expect(options.clientRegistrationAllowedScopes).toContain("offline_access");
    expect(options.clientRegistrationDefaultScopes).not.toContain("offline_access");
    expect([
      ...options.clientRegistrationDefaultScopes,
      ...options.clientRegistrationAllowedScopes,
    ]).toContain("offline_access");
  });

  it("keeps unauthenticated DCR disabled by default", () => {
    const options = createMcpOAuthOptions(DEPLOYMENT, "internal-marker");

    expect(options.allowDynamicClientRegistration).toBe(true);
    expect(options.allowUnauthenticatedClientRegistration).toBe(false);
    expect(options).not.toHaveProperty("validateInitialAccessToken");
  });

  it("fails closed when public DCR is enabled without its internal marker", () => {
    expect(() =>
      createMcpOAuthOptions({ ...DEPLOYMENT, allowPublicDcr: true }),
    ).toThrow("Public OAuth client registration requires an internal marker");
  });

  it("authorizes only the internal public-DCR marker and binds it to the fixed organization", async () => {
    const internalMarker = "internal-marker";
    const options = createMcpOAuthOptions(
      { ...DEPLOYMENT, allowPublicDcr: true },
      internalMarker,
    );

    expect(options.allowUnauthenticatedClientRegistration).toBe(false);
    expect(options.validateInitialAccessToken).toBeTypeOf("function");
    const validateInitialAccessToken = options.validateInitialAccessToken;
    if (!validateInitialAccessToken) throw new Error("expected initial access token validator");

    const validationContext = {
      headers: new Headers(),
      clientMetadata: {},
    };
    await expect(
      validateInitialAccessToken({
        ...validationContext,
        initialAccessToken: "wrong-marker",
      }),
    ).resolves.toBe(false);
    await expect(
      validateInitialAccessToken({
        ...validationContext,
        initialAccessToken: internalMarker,
      }),
    ).resolves.toEqual({ referenceId: "org_fixed" });
  });

  it.each([
    [{ token_endpoint_auth_method: "client_secret_post", redirect_uris: ["https://client.example/cb"] }],
    [{ token_endpoint_auth_method: "none", redirect_uris: ["http://client.example/cb"] }],
    [{ token_endpoint_auth_method: "none", redirect_uris: ["https://user:pass@client.example/cb"] }],
    [{ token_endpoint_auth_method: "none", redirect_uris: ["https://client.example/cb#fragment"] }],
    [{
      token_endpoint_auth_method: "none",
      grant_types: ["client_credentials"],
      redirect_uris: ["http://127.0.0.1:43110/callback"],
    }],
    [{
      token_endpoint_auth_method: "none",
      redirect_uris: ["http://127.0.0.1:43110/callback"],
      dpop_bound_access_tokens: true,
    }],
  ])("rejects unsafe public registration metadata", (body) => {
    expect(() =>
      validateMcpOAuthRequest({ path: "/oauth2/register", body, allowPublicDcr: true }),
    ).toThrow("Invalid OAuth client registration");
  });

  it.each([
    { token_endpoint_auth_method: "private_key_jwt" },
    { token_endpoint_auth_method: "extension_method" },
    {
      token_endpoint_auth_method: "client_secret_basic",
      dpop_bound_access_tokens: true,
    },
  ])("keeps unsupported rollback clients closed even when public DCR is off", (body) => {
    expect(() =>
      validateMcpOAuthRequest({
        path: "/oauth2/register",
        body,
        allowPublicDcr: false,
      }),
    ).toThrow("Invalid OAuth client registration");
  });

  it.each([
    ["/oauth2/create-client", { dpop_bound_access_tokens: true }],
    ["/oauth2/create-client", { token_endpoint_auth_method: "private_key_jwt" }],
    ["/admin/oauth2/create-client", { dpop_bound_access_tokens: true }],
    ["/admin/oauth2/create-client", { token_endpoint_auth_method: "private_key_jwt" }],
    [
      "/admin/oauth2/update-client",
      { update: { dpop_bound_access_tokens: true } },
    ],
    [
      "/admin/oauth2/create-client",
      { metadata: { dpop_bound_access_tokens: true } },
    ],
  ])("rejects rollback-incompatible managed client metadata at %s", (path, body) => {
    expect(() =>
      validateMcpOAuthRequest({
        path,
        body,
        allowPublicDcr: false,
      }),
    ).toThrow("Invalid OAuth client registration");
  });

  it.each([
    {
      path: "/oauth2/authorize",
      query: { dpop_jkt: "thumbprint" },
      body: undefined,
    },
    {
      path: "/oauth2/consent",
      query: undefined,
      body: { oauth_query: "client_id=test&dpop_jkt=thumbprint" },
    },
    {
      path: "/oauth2/continue",
      query: undefined,
      body: { dpop_jkt: "thumbprint" },
    },
  ])("rejects DPoP authorization binding at $path", ({ path, body, query }) => {
    expect(() =>
      validateMcpOAuthRequest({
        path,
        body,
        query,
        allowPublicDcr: false,
      }),
    ).toThrow("DPoP authorization is disabled during rollback");
  });

  it("rejects rollback-incompatible OAuth resource policy", () => {
    expect(() =>
      validateMcpOAuthRequest({
        path: "/admin/oauth2/resources/https%3A%2F%2Fworker.example.com%2Fmcp",
        body: { dpopBoundAccessTokensRequired: true },
        allowPublicDcr: false,
      }),
    ).toThrow("Invalid OAuth resource configuration");
  });

  it.each([
    "http://localhost:43110/callback",
    "http://127.0.0.1:43110/callback",
    "http://[::1]:43110/callback",
  ])("normalizes a safe legacy loopback registration at %s to native", (redirectUri) => {
    const body: Record<string, unknown> = {
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [redirectUri],
    };

    expect(() =>
      validateMcpOAuthRequest({
        path: "/oauth2/register",
        body,
        allowPublicDcr: true,
      }),
    ).not.toThrow();
    expect(body.application_type).toBe("native");
  });

  it("does not normalize HTTPS or an explicit application_type", () => {
    const httpsBody: Record<string, unknown> = {
      token_endpoint_auth_method: "none",
      redirect_uris: ["https://client.example/callback"],
    };
    const explicitBody: Record<string, unknown> = {
      token_endpoint_auth_method: "none",
      application_type: "web",
      redirect_uris: ["http://127.0.0.1:43110/callback"],
    };

    validateMcpOAuthRequest({
      path: "/oauth2/register",
      body: httpsBody,
      allowPublicDcr: true,
    });
    validateMcpOAuthRequest({
      path: "/oauth2/register",
      body: explicitBody,
      allowPublicDcr: true,
    });

    expect(httpsBody).not.toHaveProperty("application_type");
    expect(explicitBody.application_type).toBe("web");
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

  it.each([
    {
      referenceId: null,
      scopes: ["mcp:read"],
      clientCredentialsScopes: ["mcp:read"],
    },
    {
      referenceId: "org_fixed",
      scopes: ["admin:all"],
      clientCredentialsScopes: ["admin:all"],
    },
    {
      referenceId: "org_fixed",
      scopes: null,
      clientCredentialsScopes: ["mcp:read"],
    },
    {
      referenceId: "org_fixed",
      scopes: ["mcp:read"],
      clientCredentialsScopes: null,
    },
    {
      referenceId: "org_fixed",
      scopes: ["mcp:read", "runs:dispatch"],
      clientCredentialsScopes: ["runs:dispatch", "mcp:read"],
    },
    {
      referenceId: "org_fixed",
      scopes: ["mcp:read", "offline_access"],
      clientCredentialsScopes: ["mcp:read", "offline_access"],
    },
  ])("rejects a service client outside the exact AIW-334 scope contract", (serviceClient) => {
    expect(() =>
      validateMcpOAuthRequest({
        path: "/oauth2/token",
        body: { grant_type: "client_credentials", client_id: "service-client" },
        allowPublicDcr: false,
        serviceClient,
        organizationId: "org_fixed",
      }),
    ).toThrow("OAuth service client is not authorized");
  });

  it("accepts the exact legacy and client_credentials scopes, including authoring scopes", () => {
    const scopes = ["prompts:write", "mcp:read", "prompts:write"];

    expect(() =>
      validateMcpOAuthRequest({
        path: "/oauth2/token",
        body: { grant_type: "client_credentials", client_id: "service-client" },
        allowPublicDcr: false,
        serviceClient: {
          referenceId: "org_fixed",
          scopes,
          clientCredentialsScopes: [...scopes],
        },
        organizationId: "org_fixed",
      }),
    ).not.toThrow();
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

  it("matches Better Auth's case-insensitive Basic scheme parsing", async () => {
    const db = await serviceClientDb();

    await expect(
      validateMcpOAuthHookRequest(
        db,
        { ...DEPLOYMENT, db },
        "/oauth2/token",
        { grant_type: "client_credentials", client_id: "approved-client" },
        basicAuthorization("wrong-reference-client").replace("Basic", "basic"),
      ),
    ).rejects.toThrow("OAuth client request rejected");
  });

  it("matches Better Auth's form-decoded Basic client identity", async () => {
    const db = await serviceClientDb();
    await db.insert(oauthClient).values([
      {
        id: "oauth_encoded_spelling",
        clientId: "wrong-reference-client%2B%252F",
        redirectUris: [],
        scopes: ["mcp:read"],
        clientCredentialsScopes: ["mcp:read"],
        referenceId: "org_fixed",
      },
      {
        id: "oauth_decoded_spelling",
        clientId: "wrong-reference-client+%2F",
        redirectUris: [],
        scopes: ["mcp:read"],
        clientCredentialsScopes: ["mcp:read"],
        referenceId: "org_other",
      },
    ]);

    await expect(
      validateMcpOAuthHookRequest(
        db,
        { ...DEPLOYMENT, db },
        "/oauth2/token",
        { grant_type: "client_credentials" },
        encodeBasicCredentials("wrong-reference-client+%2F", "secret"),
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

  it("rejects a persisted client_credentials/legacy scope mismatch", async () => {
    const db = await serviceClientDb();

    await expect(
      validateMcpOAuthHookRequest(
        db,
        { ...DEPLOYMENT, db },
        "/oauth2/token",
        { grant_type: "client_credentials", client_id: "mismatched-scopes-client" },
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
      clientCredentialsScopes: ["mcp:read"],
      referenceId: "org_fixed",
    },
    {
      id: "oauth_wrong_reference",
      clientId: "wrong-reference-client",
      redirectUris: [],
      scopes: ["mcp:read"],
      clientCredentialsScopes: ["mcp:read"],
      referenceId: "org_other",
    },
    {
      id: "oauth_mismatched_scopes",
      clientId: "mismatched-scopes-client",
      redirectUris: [],
      scopes: ["mcp:read", "runs:dispatch"],
      clientCredentialsScopes: ["runs:dispatch", "mcp:read"],
      referenceId: "org_fixed",
    },
  ]);
  return db;
}

function basicAuthorization(clientId: string): string {
  return `Basic ${Buffer.from(`${clientId}:secret`).toString("base64")}`;
}
