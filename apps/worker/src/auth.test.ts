import { createHash, webcrypto } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { describe, it, expect, vi } from "vitest";
import { createTestDb } from "./db/test-db.js";
import type { Db } from "./db/client.js";
import {
  createAuth,
  seedAuthUser,
  bootstrapDashboardAuth,
  DASHBOARD_SSO_PROVIDER_ID,
  userHasCredentialAccount,
  type Auth,
  type AuthOptions,
} from "./auth.js";
import {
  account,
  member,
  oauthAccessToken,
  oauthClient,
  oauthClientResource,
  oauthRefreshToken,
  oauthResource,
  organization,
  session,
  ssoProvider,
  user,
  verification,
} from "./db/schema.js";
import { MCP_SCOPES } from "./mcp/contracts.js";
import { canonicalMcpResource } from "./mcp/oauth.js";

const OPTS = {
  secret: "x".repeat(32),
  baseURL: "http://localhost:3000",
  trustedOrigins: ["http://localhost:3001"],
};
const TEST_SSO_ISSUER = "https://idp.example.com";

type PasswordResetEmailInput = Parameters<
  NonNullable<AuthOptions["passwordReset"]>["sendEmail"]
>[0];

async function freshAuth(): Promise<Auth> {
  return createAuth(await createTestDb(), OPTS);
}

async function freshAuthContext(options: Partial<AuthOptions> = {}): Promise<{
  auth: Auth;
  db: Db;
}> {
  const db = await createTestDb();
  return {
    auth: createAuth(db, { ...OPTS, ...options }),
    db,
  };
}

async function seedTestSsoProvider(db: Db, userId: string): Promise<void> {
  await db.insert(ssoProvider).values({
    id: `sso-provider-${userId}`,
    issuer: TEST_SSO_ISSUER,
    userId,
    providerId: DASHBOARD_SSO_PROVIDER_ID,
    domain: "example.com",
    domainVerified: true,
  });
}

function tokenFrom(res: { headers: Headers; response: unknown }): string {
  return (
    res.headers.get("set-auth-token") ??
    (res.response as { token?: string }).token ??
    ""
  );
}

describe("seedAuthUser", () => {
  it("creates the user when absent", async () => {
    const auth = await freshAuth();
    const r = await seedAuthUser(auth, { email: "admin@x.com", password: "password123" });
    expect(r).toEqual({ created: true, updated: false });
  });

  it("is idempotent — no duplicate, no change on re-run", async () => {
    const auth = await freshAuth();
    await seedAuthUser(auth, { email: "admin@x.com", password: "password123" });
    const r = await seedAuthUser(auth, { email: "admin@x.com", password: "password123" });
    expect(r).toEqual({ created: false, updated: false });
    const ctx = await auth.$context;
    const found = await ctx.internalAdapter.findUserByEmail("admin@x.com");
    expect(found).not.toBeNull();
  });

  it("re-hashes when the password changes", async () => {
    const auth = await freshAuth();
    await seedAuthUser(auth, { email: "admin@x.com", password: "password123" });
    const r = await seedAuthUser(auth, { email: "admin@x.com", password: "newpassword456" });
    expect(r).toEqual({ created: false, updated: true });

    await expect(
      auth.api.signInEmail({ body: { email: "admin@x.com", password: "password123" } }),
    ).rejects.toThrow();

    const ok = await auth.api.signInEmail({
      body: { email: "admin@x.com", password: "newpassword456" },
      returnHeaders: true,
    });
    expect(tokenFrom(ok)).toBeTruthy();
  });

  it("links a credential account for an existing SSO-only owner", async () => {
    const { auth, db } = await freshAuthContext();
    const ctx = await auth.$context;
    const created = await ctx.internalAdapter.createUser(
      {
        email: "owner@example.com",
        name: "Owner",
        emailVerified: true,
      },
      { method: "admin" },
    );
    await seedTestSsoProvider(db, created.id);
    await ctx.internalAdapter.linkAccount({
      userId: created.id,
      providerId: DASHBOARD_SSO_PROVIDER_ID,
      issuer: TEST_SSO_ISSUER,
      accountId: "sso-subject",
    });

    const r = await seedAuthUser(auth, {
      email: "owner@example.com",
      password: "password123",
    });

    expect(r).toEqual({ created: false, updated: true });
    await expect(userHasCredentialAccount(db, created.id)).resolves.toBe(true);
    const accounts = await db
      .select()
      .from(account)
      .where(eq(account.userId, created.id));
    expect(accounts.map((row) => row.providerId).sort()).toEqual([
      "credential",
      DASHBOARD_SSO_PROVIDER_ID,
    ]);
    const signIn = await auth.api.signInEmail({
      body: { email: "owner@example.com", password: "password123" },
      returnHeaders: true,
    });
    expect(tokenFrom(signIn)).toBeTruthy();
  });

  it("resolves concurrent credential linking for an existing SSO-only owner", async () => {
    const { auth, db } = await freshAuthContext();
    const ctx = await auth.$context;
    const created = await ctx.internalAdapter.createUser(
      {
        email: "owner@example.com",
        name: "Owner",
        emailVerified: true,
      },
      { method: "admin" },
    );
    await seedTestSsoProvider(db, created.id);
    await ctx.internalAdapter.linkAccount({
      userId: created.id,
      providerId: DASHBOARD_SSO_PROVIDER_ID,
      issuer: TEST_SSO_ISSUER,
      accountId: "sso-subject",
    });

    await expect(
      Promise.all([
        seedAuthUser(auth, { email: "owner@example.com", password: "password123" }),
        seedAuthUser(auth, { email: "owner@example.com", password: "password123" }),
      ]),
    ).resolves.toHaveLength(2);

    const credentials = await db
      .select()
      .from(account)
      .where(
        and(
          eq(account.userId, created.id),
          eq(account.providerId, "credential"),
        ),
      );
    expect(credentials).toHaveLength(1);
  });
});

describe("bootstrapDashboardAuth", () => {
  const bootstrapOptions = {
    owner: { email: "owner@acme.test", password: "password123", name: "Owner" },
    organization: { name: "AI Workflow", slug: "ai-workflow" },
  };

  it("creates the fixed organization and owner membership", async () => {
    const { auth, db } = await freshAuthContext();

    const result = await bootstrapDashboardAuth(auth, db, bootstrapOptions);

    expect(result.user).toEqual({ created: true, updated: false });
    expect(result.organization).toEqual({ created: true });
    expect(result.membership).toEqual({ created: true, updated: false });

    const [createdOrg] = await db
      .select()
      .from(organization)
      .where(eq(organization.slug, "ai-workflow"));
    expect(createdOrg).toMatchObject({
      name: "AI Workflow",
      slug: "ai-workflow",
    });

    const [ownerUser] = await db
      .select()
      .from(user)
      .where(eq(user.email, "owner@acme.test"));
    const [ownerMember] = await db
      .select()
      .from(member)
      .where(
        and(
          eq(member.organizationId, createdOrg.id),
          eq(member.userId, ownerUser.id),
        ),
      );

    expect(ownerMember).toMatchObject({ role: "owner" });
  });

  it("is idempotent for the organization and owner membership", async () => {
    const { auth, db } = await freshAuthContext();

    await bootstrapDashboardAuth(auth, db, bootstrapOptions);
    const result = await bootstrapDashboardAuth(auth, db, bootstrapOptions);

    expect(result.organization).toEqual({ created: false });
    expect(result.membership).toEqual({ created: false, updated: false });

    const orgs = await db.select().from(organization);
    const members = await db.select().from(member);
    expect(orgs).toHaveLength(1);
    expect(members).toHaveLength(1);
    expect(members[0].role).toBe("owner");
  });

  it("repairs an existing owner membership if the role drifted", async () => {
    const { auth, db } = await freshAuthContext();

    await bootstrapDashboardAuth(auth, db, bootstrapOptions);
    const [ownerMember] = await db.select().from(member);
    await db
      .update(member)
      .set({ role: "member" })
      .where(eq(member.id, ownerMember.id));

    const result = await bootstrapDashboardAuth(auth, db, bootstrapOptions);

    expect(result.membership).toEqual({ created: false, updated: true });
    const [repaired] = await db.select().from(member).where(eq(member.id, ownerMember.id));
    expect(repaired.role).toBe("owner");
  });

  it("upserts the env-backed OIDC provider when SSO is configured", async () => {
    const { auth, db } = await freshAuthContext();

    const first = await bootstrapDashboardAuth(auth, db, {
      ...bootstrapOptions,
      sso: {
        issuer: "https://idp.acme.test",
        allowedDomain: "acme.test",
        clientId: "client-id",
        clientSecret: "client-secret",
      },
    });

    expect(first.ssoProvider).toEqual({ created: true, updated: false });

    const second = await bootstrapDashboardAuth(auth, db, {
      ...bootstrapOptions,
      sso: {
        issuer: "https://idp.acme.test",
        allowedDomain: "users.acme.test",
        clientId: "client-id-2",
        clientSecret: "client-secret-2",
      },
    });

    expect(second.ssoProvider).toEqual({ created: false, updated: true });

    const providers = await db.select().from(ssoProvider);
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      providerId: DASHBOARD_SSO_PROVIDER_ID,
      issuer: "https://idp.acme.test",
      domain: "users.acme.test",
      domainVerified: true,
    });
    expect(JSON.parse(providers[0].oidcConfig ?? "{}")).toMatchObject({
      issuer: "https://idp.acme.test",
      clientId: "client-id-2",
      clientSecret: "client-secret-2",
      pkce: true,
      scopes: ["openid", "email", "profile"],
    });
  });

  it("fails closed when ordinary bootstrap would change an SSO issuer", async () => {
    const { auth, db } = await freshAuthContext();
    const initial = {
      ...bootstrapOptions,
      sso: {
        issuer: "https://idp.acme.test",
        allowedDomain: "acme.test",
        clientId: "client-id",
        clientSecret: "client-secret",
      },
    };
    await bootstrapDashboardAuth(auth, db, initial);

    await expect(
      bootstrapDashboardAuth(auth, db, {
        ...initial,
        sso: { ...initial.sso, issuer: "https://replacement-idp.acme.test" },
      }),
    ).rejects.toThrow(
      "Dashboard SSO issuer cannot change during the Better Auth compatibility window; " +
        "run a controlled account identity migration first",
    );

    const [provider] = await db.select().from(ssoProvider);
    expect(provider.issuer).toBe("https://idp.acme.test");
  });
});

describe("bearer round-trip", () => {
  it("accepts a valid bearer and rejects bad/missing", async () => {
    const auth = await freshAuth();
    await seedAuthUser(auth, { email: "admin@x.com", password: "password123" });
    const signIn = await auth.api.signInEmail({
      body: { email: "admin@x.com", password: "password123" },
      returnHeaders: true,
    });
    const token = tokenFrom(signIn);
    expect(token).toBeTruthy();

    const good = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${token}` }),
    });
    expect(good?.user.email).toBe("admin@x.com");

    const bad = await auth.api.getSession({
      headers: new Headers({ authorization: "Bearer nope" }),
    });
    expect(bad).toBeNull();
  });
});

describe("MCP OAuth provider", () => {
  it("loads the installed provider and exposes OAuth metadata without breaking auth", async () => {
    const db = await createTestDb();
    await db.insert(organization).values({
      id: "org_fixed",
      name: "AI Workflow",
      slug: "ai-workflow",
    });
    const auth = createAuth(db, {
      ...OPTS,
      mcp: {
        organizationId: "org_fixed",
        allowPublicDcr: false,
      },
    });

    await expect(auth.api.getOAuthServerConfig()).resolves.toMatchObject({
      issuer: "http://localhost:3000/api/auth",
      scopes_supported: [...MCP_SCOPES, "offline_access"],
      registration_endpoint: "http://localhost:3000/api/auth/oauth2/register",
      code_challenge_methods_supported: expect.arrayContaining(["S256"]),
      grant_types_supported: expect.arrayContaining([
        "authorization_code",
        "client_credentials",
        "refresh_token",
      ]),
      dpop_signing_alg_values_supported: [],
    });
  });

  it("rejects a valid DPoP proof at token issuance throughout the rollback window", async () => {
    const db = await createTestDb();
    await db.insert(organization).values({
      id: "org_fixed",
      name: "AI Workflow",
      slug: "ai-workflow",
    });
    const auth = createAuth(db, {
      ...OPTS,
      mcp: { organizationId: "org_fixed", allowPublicDcr: false },
    });
    await auth.$context;
    const clientSecret = "service-client-secret";
    await db.insert(oauthClient).values({
      id: "dpop-service-client",
      clientId: "dpop-service-client",
      clientSecret: createHash("sha256").update(clientSecret).digest("base64url"),
      tokenEndpointAuthMethod: "client_secret_post",
      grantTypes: ["client_credentials"],
      redirectUris: [],
      scopes: ["mcp:read"],
      clientCredentialsScopes: ["mcp:read"],
      referenceId: "org_fixed",
    });
    const bearerResponse = await requestClientCredentialsToken(
      auth,
      "dpop-service-client",
      clientSecret,
    );
    expect(bearerResponse.status, await bearerResponse.clone().text()).toBe(200);

    const tokenEndpoint = "http://localhost:3000/api/auth/oauth2/token";
    const dpopResponse = await requestClientCredentialsToken(
      auth,
      "dpop-service-client",
      clientSecret,
      await createValidDpopProof(tokenEndpoint),
    );
    expect(dpopResponse.status).toBe(400);
    await expect(dpopResponse.json()).resolves.toMatchObject({
      error: "invalid_dpop_proof",
    });
  });

  it("rejects lowercase Basic credentials for a different client before token issuance", async () => {
    const db = await createTestDb();
    await db.insert(organization).values({
      id: "org_fixed",
      name: "AI Workflow",
      slug: "ai-workflow",
    });
    const auth = createAuth(db, {
      ...OPTS,
      mcp: { organizationId: "org_fixed", allowPublicDcr: false },
    });
    await auth.$context;
    const approvedSecret = "approved-service-secret";
    const rejectedSecret = "rejected-service-secret";
    await db.insert(oauthClient).values([
      {
        id: "approved-basic-client",
        clientId: "approved-basic-client",
        clientSecret: createHash("sha256").update(approvedSecret).digest("base64url"),
        tokenEndpointAuthMethod: "client_secret_basic",
        grantTypes: ["client_credentials"],
        redirectUris: [],
        scopes: ["mcp:read"],
        clientCredentialsScopes: ["mcp:read"],
        referenceId: "org_fixed",
      },
      {
        id: "rejected-basic-client",
        clientId: "rejected-basic-client",
        clientSecret: createHash("sha256").update(rejectedSecret).digest("base64url"),
        tokenEndpointAuthMethod: "client_secret_basic",
        grantTypes: ["client_credentials"],
        redirectUris: [],
        scopes: ["mcp:read", "runs:dispatch"],
        clientCredentialsScopes: ["runs:dispatch", "mcp:read"],
        referenceId: "org_fixed",
      },
    ]);
    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/oauth2/token", {
        method: "POST",
        headers: {
          authorization: `basic ${Buffer.from(
            `rejected-basic-client:${rejectedSecret}`,
          ).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: "approved-basic-client",
          scope: "mcp:read",
          resource: canonicalMcpResource(OPTS.baseURL),
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_client_metadata",
    });
    await expect(db.select().from(oauthAccessToken)).resolves.toHaveLength(0);
  });

  it("binds a current no-resource token to the canonical resource instead of the legacy bridge", async () => {
    const db = await createTestDb();
    await db.insert(organization).values({
      id: "org_fixed",
      name: "AI Workflow",
      slug: "ai-workflow",
    });
    const auth = createAuth(db, {
      ...OPTS,
      mcp: {
        organizationId: "org_fixed",
        allowPublicDcr: false,
        allowLegacyUnboundAccessTokens: true,
      },
    });
    await auth.$context;
    const clientSecret = "canonical-default-secret";
    await db.insert(oauthClient).values({
      id: "canonical-default-client",
      clientId: "canonical-default-client",
      clientSecret: createHash("sha256").update(clientSecret).digest("base64url"),
      tokenEndpointAuthMethod: "client_secret_post",
      grantTypes: ["client_credentials"],
      redirectUris: [],
      scopes: ["mcp:read"],
      clientCredentialsScopes: ["mcp:read"],
      referenceId: "org_fixed",
    });
    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: "canonical-default-client",
          client_secret: clientSecret,
          scope: "mcp:read",
        }),
      }),
    );

    expect(response.status, await response.clone().text()).toBe(200);
    const tokenResponse = (await response.json()) as { access_token: string };
    const [persisted] = await db
      .select({
        clientId: oauthAccessToken.clientId,
        referenceId: oauthAccessToken.referenceId,
        resources: oauthAccessToken.resources,
        userId: oauthAccessToken.userId,
      })
      .from(oauthAccessToken);
    expect(persisted).toEqual({
      clientId: "canonical-default-client",
      referenceId: "org_fixed",
      resources: [canonicalMcpResource(OPTS.baseURL)],
      userId: null,
    });
    const verification = await auth.api.verifyMcpAccessToken({
      body: { token: tokenResponse.access_token },
    });
    expect(verification.claims.aud).toBe(canonicalMcpResource(OPTS.baseURL));
    expect(verification).not.toHaveProperty("legacyUnboundAudience");
  });

  it("rejects unauthenticated DCR by default", async () => {
    const db = await createTestDb();
    await db.insert(organization).values({
      id: "org_fixed",
      name: "AI Workflow",
      slug: "ai-workflow",
    });
    const auth = createAuth(db, {
      ...OPTS,
      mcp: { organizationId: "org_fixed", allowPublicDcr: false },
    });

    const response = await registerPublicClient(auth, "https://client.example/callback");
    expect(response.status).toBeGreaterThanOrEqual(400);
    await expect(db.select().from(oauthClient)).resolves.toHaveLength(0);
  });

  it("registers only safe public clients when DCR is enabled", async () => {
    const db = await createTestDb();
    await db.insert(organization).values({
      id: "org_fixed",
      name: "AI Workflow",
      slug: "ai-workflow",
    });
    const auth = createAuth(db, {
      ...OPTS,
      mcp: { organizationId: "org_fixed", allowPublicDcr: true },
    });
    // The provider itself stays closed to anonymous registration; the public
    // deployment metadata route advertises token-backed public clients.
    await expect(auth.api.getOAuthServerConfig()).resolves.toMatchObject({
      token_endpoint_auth_methods_supported: expect.not.arrayContaining(["none"]),
    });

    const safe = await registerPublicClient(auth, "http://127.0.0.1:43110/callback");
    expect(safe.status, await safe.clone().text()).toBe(201);
    const registration = (await safe.json()) as Record<string, unknown>;
    expect(registration).toMatchObject({
      application_type: "native",
      token_endpoint_auth_method: "none",
      redirect_uris: ["http://127.0.0.1:43110/callback"],
      resources: [canonicalMcpResource(OPTS.baseURL)],
    });
    const capabilityScopes = String(registration.scope).split(" ");
    expect(capabilityScopes).toEqual([...MCP_SCOPES, "offline_access"]);

    const [persistedClient] = await db
      .select({
        applicationType: oauthClient.applicationType,
        referenceId: oauthClient.referenceId,
        scopes: oauthClient.scopes,
      })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, String(registration.client_id)));
    expect(persistedClient).toEqual({
      applicationType: "native",
      referenceId: "org_fixed",
      scopes: [...MCP_SCOPES, "offline_access"],
    });
    await expect(
      db
        .select({ resourceId: oauthClientResource.resourceId })
        .from(oauthClientResource)
        .where(eq(oauthClientResource.clientId, String(registration.client_id))),
    ).resolves.toEqual([{ resourceId: canonicalMcpResource(OPTS.baseURL) }]);

    // Registration records the client's maximum capabilities. It does not grant
    // offline access by itself; a refresh token still needs an explicit user grant.
    await expect(db.select().from(oauthRefreshToken)).resolves.toHaveLength(0);

    const unsafe = await registerPublicClient(auth, "http://client.example/callback");
    expect(unsafe.status).toBeGreaterThanOrEqual(400);
  });

  it("rolls back the DCR client when its resource-link insert fails", async () => {
    const db = await createTestDb();
    await db.insert(organization).values({
      id: "org_fixed",
      name: "AI Workflow",
      slug: "ai-workflow",
    });
    const auth = createAuth(db, {
      ...OPTS,
      mcp: { organizationId: "org_fixed", allowPublicDcr: true },
    });
    await auth.$context;
    await db.execute(sql.raw(`
      CREATE FUNCTION fail_oauth_client_resource_insert() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected oauth_client_resource insert failure';
      END;
      $$ LANGUAGE plpgsql
    `));
    await db.execute(sql.raw(`
      CREATE TRIGGER fail_oauth_client_resource_insert
      BEFORE INSERT ON oauth_client_resource
      FOR EACH ROW EXECUTE FUNCTION fail_oauth_client_resource_insert()
    `));
    await db.execute(
      sql.raw(
        'ALTER TABLE oauth_client DISABLE TRIGGER "oauth_client_rollback_resource_link"',
      ),
    );

    let response: Response;
    try {
      response = await registerPublicClient(
        auth,
        "http://127.0.0.1:43110/callback",
      );
    } finally {
      await db.execute(
        sql.raw(
          'ALTER TABLE oauth_client ENABLE TRIGGER "oauth_client_rollback_resource_link"',
        ),
      );
    }

    expect(response.status).toBe(500);
    await expect(db.select().from(oauthClient)).resolves.toHaveLength(0);
    await expect(db.select().from(oauthClientResource)).resolves.toHaveLength(0);
  });

  it("binds direct auth.api DCR to the fixed organization", async () => {
    const db = await createTestDb();
    await db.insert(organization).values({
      id: "org_fixed",
      name: "AI Workflow",
      slug: "ai-workflow",
    });
    const auth = createAuth(db, {
      ...OPTS,
      mcp: { organizationId: "org_fixed", allowPublicDcr: true },
    });

    const registration = await auth.api.registerOAuthClient({
      body: publicClientRegistrationBody("http://127.0.0.1:43110/callback"),
    });

    const [persistedClient] = await db
      .select({ referenceId: oauthClient.referenceId })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, registration.client_id));
    expect(persistedClient).toEqual({ referenceId: "org_fixed" });
  });

  it("preserves session-backed DCR while the public bridge is enabled", async () => {
    const db = await createTestDb();
    await db.insert(organization).values({
      id: "org_fixed",
      name: "AI Workflow",
      slug: "ai-workflow",
    });
    const auth = createAuth(db, {
      ...OPTS,
      mcp: { organizationId: "org_fixed", allowPublicDcr: true },
    });
    await seedAuthUser(auth, { email: "admin@x.com", password: "password123" });
    const signIn = await auth.api.signInEmail({
      body: { email: "admin@x.com", password: "password123" },
      returnHeaders: true,
    });
    const token = tokenFrom(signIn);
    await db.update(session).set({ activeOrganizationId: "org_fixed" });

    const response = await registerPublicClient(
      auth,
      "http://127.0.0.1:43110/callback",
      {},
      `Bearer ${token}`,
    );

    expect(response.status, await response.clone().text()).toBe(201);
    const registration = (await response.json()) as { client_id: string };
    const [persistedClient] = await db
      .select({ referenceId: oauthClient.referenceId })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, registration.client_id));
    expect(persistedClient).toEqual({ referenceId: "org_fixed" });
  });

  it("rejects session-backed DCR for another active organization without writing", async () => {
    const db = await createTestDb();
    await db.insert(organization).values([
      { id: "org_fixed", name: "AI Workflow", slug: "ai-workflow" },
      { id: "org_other", name: "Other", slug: "other" },
    ]);
    const auth = createAuth(db, {
      ...OPTS,
      mcp: { organizationId: "org_fixed", allowPublicDcr: true },
    });
    await seedAuthUser(auth, { email: "admin@x.com", password: "password123" });
    const signIn = await auth.api.signInEmail({
      body: { email: "admin@x.com", password: "password123" },
      returnHeaders: true,
    });
    await db
      .update(session)
      .set({ activeOrganizationId: "org_other" });

    const response = await registerPublicClient(
      auth,
      "http://127.0.0.1:43110/callback",
      {},
      `Bearer ${tokenFrom(signIn)}`,
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    await expect(db.select().from(oauthClient)).resolves.toHaveLength(0);
    await expect(db.select().from(oauthClientResource)).resolves.toHaveLength(0);
  });

  it.each(["Bearer attacker-token", "Basic attacker-token", ""])(
    "preserves and rejects caller Authorization %j during public DCR",
    async (authorization) => {
      const db = await createTestDb();
      await db.insert(organization).values({
        id: "org_fixed",
        name: "AI Workflow",
        slug: "ai-workflow",
      });
      const auth = createAuth(db, {
        ...OPTS,
        mcp: { organizationId: "org_fixed", allowPublicDcr: true },
      });

      const response = await registerPublicClient(
        auth,
        "http://127.0.0.1:43110/callback",
        {},
        authorization,
      );

      expect(response.status).toBeGreaterThanOrEqual(400);
      await expect(db.select().from(oauthClient)).resolves.toHaveLength(0);
    },
  );

  it("fails public DCR closed when the fixed organization is missing", async () => {
    const db = await createTestDb();
    const auth = createAuth(db, {
      ...OPTS,
      mcp: { organizationSlug: "missing", allowPublicDcr: true },
    });

    const response = await registerPublicClient(
      auth,
      "http://127.0.0.1:43110/callback",
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    await expect(db.select().from(oauthClient)).resolves.toHaveLength(0);
  });

  it("rejects DPoP-bound dynamic client registration during the rollback window", async () => {
    const db = await createTestDb();
    await db.insert(organization).values({
      id: "org_fixed",
      name: "AI Workflow",
      slug: "ai-workflow",
    });
    const auth = createAuth(db, {
      ...OPTS,
      mcp: { organizationId: "org_fixed", allowPublicDcr: true },
    });

    const response = await registerPublicClient(
      auth,
      "http://127.0.0.1:43110/callback",
      { dpop_bound_access_tokens: true },
    );

    expect(response.status).toBe(400);
    await expect(db.select().from(oauthClient)).resolves.toHaveLength(0);
  });

  it("rejects DPoP authorization and managed/admin rollback-incompatible writes before persistence", async () => {
    const db = await createTestDb();
    await db.insert(organization).values({
      id: "org_fixed",
      name: "AI Workflow",
      slug: "ai-workflow",
    });
    const auth = createAuth(db, {
      ...OPTS,
      mcp: { organizationId: "org_fixed", allowPublicDcr: true },
    });
    await auth.$context;
    const clientCountBefore = (await db.select().from(oauthClient)).length;
    const resourceCountBefore = (await db.select().from(oauthResource)).length;

    const authorize = await auth.handler(
      new Request(
        `http://localhost:3000/api/auth/oauth2/authorize?client_id=test&dpop_jkt=${"a".repeat(43)}`,
      ),
    );
    expect(authorize.status).toBe(400);

    for (const body of [
      { dpop_bound_access_tokens: true },
      { token_endpoint_auth_method: "private_key_jwt" },
    ]) {
      const response = await auth.handler(
        new Request("http://localhost:3000/api/auth/oauth2/create-client", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(400);
    }

    await expect(
      auth.api.adminCreateOAuthClient({
        body: { token_endpoint_auth_method: "private_key_jwt" },
      }),
    ).rejects.toThrow("OAuth client request rejected");
    await expect(
      auth.api.adminUpdateOAuthClient({
        body: {
          client_id: "missing-client",
          update: { dpop_bound_access_tokens: true },
        },
      }),
    ).rejects.toThrow("OAuth client request rejected");
    await expect(
      auth.api.adminCreateOAuthResource({
        body: {
          identifier: "https://dpop.example/mcp",
          dpopBoundAccessTokensRequired: true,
        },
      }),
    ).rejects.toThrow("OAuth client request rejected");

    await expect(db.select().from(oauthClient)).resolves.toHaveLength(
      clientCountBefore,
    );
    await expect(db.select().from(oauthResource)).resolves.toHaveLength(
      resourceCountBefore,
    );
  });

  /**
   * The MCP branch of createAuth also mounts jwt(), and jwt() hooks
   * /get-session to mint a JWT from a key it reads out of the jwks table. So
   * with MCP on, a broken jwks store does not break sign-in, it breaks every
   * later session read: exactly the shape of the production incident where
   * POST /sign-in/email returned 200 and /api/v1/session returned 500. None of
   * the tests above touch a session, which is why the missing table stayed
   * invisible. Keep a session read in the MCP-enabled path.
   */
  it("still reads a session, and serves JWKS, once MCP mounts the jwt plugin", async () => {
    const db = await createTestDb();
    await db.insert(organization).values({
      id: "org_fixed",
      name: "AI Workflow",
      slug: "ai-workflow",
    });
    const auth = createAuth(db, {
      ...OPTS,
      mcp: { organizationId: "org_fixed", allowPublicDcr: false },
    });
    await seedAuthUser(auth, { email: "admin@x.com", password: "password123" });

    const signIn = await auth.api.signInEmail({
      body: { email: "admin@x.com", password: "password123" },
      returnHeaders: true,
    });
    const token = tokenFrom(signIn);
    expect(token).toBeTruthy();

    const session = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${token}` }),
    });
    expect(session?.user.email).toBe("admin@x.com");

    // The probe that separated the broken deployment from the healthy one: 500
    // against a schema without jwks, 404 on a deployment with MCP switched off.
    await expect(auth.api.getJwks()).resolves.toMatchObject({
      keys: expect.arrayContaining([expect.objectContaining({ kid: expect.any(String) })]),
    });
  });

  it("accepts a genuine 1.6 unbound opaque token only through the temporary server-only bridge", async () => {
    const { auth, db } = await mcpVerifierFixture(true);
    const rawToken = "legacy-opaque-access-token";
    await insertHistoricalOpaqueAccessToken(db, rawToken, {
      id: "legacy-unbound",
      referenceId: null,
      resources: null,
    });

    const verification = await auth.api.verifyMcpAccessToken({
      body: { token: rawToken },
    });

    expect(verification).toMatchObject({
      legacyUnboundAudience: true,
      claims: {
        active: true,
        iss: "http://localhost:3000/api/auth",
        azp: "client_1",
        organization_id: "org_fixed",
        organization_role: "service",
        scope: "mcp:read runs:dispatch",
      },
    });
    expect(verification.claims.aud).toBeUndefined();

    const emptyResourcesToken = "legacy-empty-resources-token";
    await insertHistoricalOpaqueAccessToken(db, emptyResourcesToken, {
      id: "legacy-empty-resources",
      referenceId: null,
      resources: [],
    });
    await expect(
      auth.api.verifyMcpAccessToken({ body: { token: emptyResourcesToken } }),
    ).resolves.toMatchObject({ legacyUnboundAudience: true });

    const strictAuth = createAuth(db, {
      ...OPTS,
      mcp: {
        organizationId: "org_fixed",
        allowPublicDcr: false,
        allowLegacyUnboundAccessTokens: false,
      },
    });
    await expect(
      strictAuth.api.verifyMcpAccessToken({ body: { token: rawToken } }),
    ).rejects.toThrow();

    const publicResponse = await auth.handler(
      new Request("http://localhost:3000/api/auth/verify-mcp-access-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: rawToken }),
      }),
    );
    expect(publicResponse.status).toBe(404);
  });

  it("keeps an exact canonical audience on bound opaque and JWT access tokens", async () => {
    const { auth, db } = await mcpVerifierFixture(true);
    const audience = canonicalMcpResource(OPTS.baseURL);
    const opaqueToken = "bound-opaque-access-token";
    await insertOpaqueAccessToken(db, opaqueToken, {
      id: "bound-opaque",
      resources: [audience],
    });

    const opaqueVerification = await auth.api.verifyMcpAccessToken({
      body: { token: opaqueToken },
    });
    expect(opaqueVerification.claims.aud).toBe(audience);
    expect(opaqueVerification).not.toHaveProperty("legacyUnboundAudience");

    const { token: jwtToken } = await auth.api.signJWT({
      body: {
        payload: {
          sub: "client_1",
          azp: "client_1",
          iss: "http://localhost:3000/api/auth",
          aud: audience,
          scope: "mcp:read runs:dispatch",
          organization_id: "org_fixed",
          organization_role: "service",
        },
      },
    });
    const jwtVerification = await auth.api.verifyMcpAccessToken({
      body: { token: jwtToken },
    });
    expect(jwtVerification.claims.aud).toBe(audience);
    expect(jwtVerification).not.toHaveProperty("legacyUnboundAudience");

    await db.delete(oauthClientResource);
    await expect(
      auth.api.verifyMcpAccessToken({ body: { token: jwtToken } }),
    ).rejects.toThrow();

    await db.insert(oauthClientResource).values({
      id: "oauth-link-restored-for-jwt",
      clientId: "client_1",
      resourceId: audience,
    });

    const { token: senderConstrainedJwt } = await auth.api.signJWT({
      body: {
        payload: {
          sub: "client_1",
          azp: "client_1",
          iss: "http://localhost:3000/api/auth",
          aud: audience,
          scope: "mcp:read runs:dispatch",
          organization_id: "org_fixed",
          organization_role: "service",
          cnf: { jkt: "thumbprint" },
        },
      },
    });
    await expect(
      auth.api.verifyMcpAccessToken({ body: { token: senderConstrainedJwt } }),
    ).rejects.toThrow();

    await db
      .update(oauthResource)
      .set({ disabled: true })
      .where(eq(oauthResource.identifier, audience));
    await expect(
      auth.api.verifyMcpAccessToken({ body: { token: jwtToken } }),
    ).rejects.toThrow();
  });

  it("rejects inactive, disabled, wrongly bound, and unknown opaque tokens", async () => {
    const { auth, db } = await mcpVerifierFixture(true);
    await db.insert(user).values({
      id: "session-user",
      name: "Session User",
      email: "session@example.com",
      emailVerified: true,
    });
    await db.insert(session).values({
      id: "expired-session",
      userId: "session-user",
      token: "expired-session-token",
      expiresAt: new Date(Date.now() - 1_000),
    });
    await Promise.all([
      insertOpaqueAccessToken(db, "expired-token", {
        id: "expired",
        resources: null,
        expiresAt: new Date(Date.now() - 1_000),
      }),
      insertOpaqueAccessToken(db, "revoked-token", {
        id: "revoked",
        resources: null,
        revoked: new Date(),
      }),
      insertOpaqueAccessToken(db, "disabled-client-token", {
        id: "disabled-client",
        resources: null,
      }),
      insertOpaqueAccessToken(db, "expired-session-access-token", {
        id: "expired-session-access",
        resources: null,
        sessionId: "expired-session",
      }),
      insertOpaqueAccessToken(db, "stored-under-different-hash", {
        id: "hash-mismatch",
        resources: null,
      }),
    ]);
    await insertHistoricalOpaqueAccessToken(db, "wrong-reference-token", {
      id: "wrong-reference",
      referenceId: "org_other",
      resources: null,
    });
    await insertHistoricalOpaqueAccessToken(db, "foreign-resource-token", {
      id: "foreign-resource",
      resources: ["https://foreign.example.com/mcp"],
    });

    for (const token of [
      "expired-token",
      "revoked-token",
      "wrong-reference-token",
      "expired-session-access-token",
      "foreign-resource-token",
      "hash-mismatch-token",
      "unknown-token",
    ]) {
      await expect(
        auth.api.verifyMcpAccessToken({ body: { token } }),
      ).rejects.toThrow();
    }

    await db.delete(oauthClientResource);
    await expect(
      auth.api.verifyMcpAccessToken({ body: { token: "disabled-client-token" } }),
    ).rejects.toThrow();
    await db.insert(oauthClientResource).values({
      id: "oauth-link-restored",
      clientId: "client_1",
      resourceId: canonicalMcpResource(OPTS.baseURL),
    });

    await db
      .update(oauthResource)
      .set({ disabled: true })
      .where(eq(oauthResource.identifier, canonicalMcpResource(OPTS.baseURL)));
    await expect(
      auth.api.verifyMcpAccessToken({ body: { token: "disabled-client-token" } }),
    ).rejects.toThrow();
    await db
      .update(oauthResource)
      .set({ disabled: false })
      .where(eq(oauthResource.identifier, canonicalMcpResource(OPTS.baseURL)));

    await db
      .update(oauthClient)
      .set({ referenceId: "org_other" })
      .where(eq(oauthClient.clientId, "client_1"));
    await expect(
      auth.api.verifyMcpAccessToken({ body: { token: "disabled-client-token" } }),
    ).rejects.toThrow();
    await db
      .update(oauthClient)
      .set({ referenceId: "org_fixed" })
      .where(eq(oauthClient.clientId, "client_1"));

    await db
      .update(oauthClient)
      .set({ disabled: true })
      .where(eq(oauthClient.clientId, "client_1"));
    await expect(
      auth.api.verifyMcpAccessToken({ body: { token: "disabled-client-token" } }),
    ).rejects.toThrow();
  });
});

async function mcpVerifierFixture(
  allowLegacyUnboundAccessTokens: boolean,
): Promise<{ auth: Auth; db: Db }> {
  const db = await createTestDb();
  await db.insert(organization).values({
    id: "org_fixed",
    name: "AI Workflow",
    slug: "ai-workflow",
  });
  await db.insert(oauthClient).values({
    id: "oauth_1",
    clientId: "client_1",
    redirectUris: ["https://client.example/callback"],
    scopes: ["mcp:read", "runs:dispatch"],
    referenceId: "org_fixed",
  });
  const auth = createAuth(db, {
    ...OPTS,
    mcp: {
      organizationId: "org_fixed",
      allowPublicDcr: false,
      allowLegacyUnboundAccessTokens,
    },
  });
  await auth.$context;
  return { auth, db };
}

async function insertOpaqueAccessToken(
  db: Db,
  rawToken: string,
  overrides: Partial<typeof oauthAccessToken.$inferInsert> & { id: string },
): Promise<void> {
  await db.insert(oauthAccessToken).values({
    token: createHash("sha256").update(rawToken).digest("base64url"),
    clientId: "client_1",
    referenceId: "org_fixed",
    resources: null,
    scopes: ["mcp:read", "runs:dispatch"],
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  });
}

async function insertHistoricalOpaqueAccessToken(
  db: Db,
  rawToken: string,
  overrides: Partial<typeof oauthAccessToken.$inferInsert> & { id: string },
): Promise<void> {
  // createTestDb applies 0059. Temporarily bypass only the new-resource trigger
  // so this fixture can represent a row that existed before 0059 was installed.
  await db.execute(
    sql.raw(
      'ALTER TABLE oauth_access_token DISABLE TRIGGER "oauth_access_token_rollback_resource_guard"',
    ),
  );
  try {
    await insertOpaqueAccessToken(db, rawToken, overrides);
  } finally {
    await db.execute(
      sql.raw(
        'ALTER TABLE oauth_access_token ENABLE TRIGGER "oauth_access_token_rollback_resource_guard"',
      ),
    );
  }
}

function requestClientCredentialsToken(
  auth: Auth,
  clientId: string,
  clientSecret: string,
  dpopProof?: string,
): Promise<Response> {
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
  });
  if (dpopProof) headers.set("dpop", dpopProof);
  return auth.handler(
    new Request("http://localhost:3000/api/auth/oauth2/token", {
      method: "POST",
      headers,
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "mcp:read",
        resource: canonicalMcpResource(OPTS.baseURL),
      }),
    }),
  );
}

async function createValidDpopProof(url: string): Promise<string> {
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await webcrypto.subtle.exportKey("jwk", keyPair.publicKey);
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: publicJwk,
  })}.${encode({
    htm: "POST",
    htu: url,
    jti: "rollback-window-dpop-proof",
    iat: Math.floor(Date.now() / 1_000),
  })}`;
  const signature = await webcrypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
}

function registerPublicClient(
  auth: Auth,
  redirectUri: string,
  overrides: Record<string, unknown> = {},
  authorization?: string,
): Promise<Response> {
  const headers = new Headers({
    "content-type": "application/json",
    origin: "http://localhost:3000",
  });
  if (authorization !== undefined) headers.set("authorization", authorization);

  return auth.handler(
    new Request("http://localhost:3000/api/auth/oauth2/register", {
      method: "POST",
      headers,
      body: JSON.stringify(publicClientRegistrationBody(redirectUri, overrides)),
    }),
  );
}

function publicClientRegistrationBody(
  redirectUri: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    client_name: "MCP Client",
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code" as const],
    redirect_uris: [redirectUri],
    scope: "mcp:read runs:dispatch",
    ...overrides,
  };
}

describe("password reset", () => {
  it("sends dashboard reset links for existing password users", async () => {
    const sent: PasswordResetEmailInput[] = [];
    const sendEmail = vi.fn(async (input: PasswordResetEmailInput) => {
      sent.push(input);
    });
    const db = await createTestDb();
    const auth = createAuth(db, {
      ...OPTS,
      passwordReset: {
        dashboardOrigin: "https://dashboard.example.com",
        sendEmail,
      },
    });
    await seedAuthUser(auth, {
      email: "password@example.com",
      password: "password123",
      name: "Password User",
    });

    const res = await auth.handler(
      new Request("http://localhost:3000/api/auth/request-password-reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "password@example.com" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const email = sent[0];
    if (!email) throw new Error("expected password reset email");
    expect(email).toMatchObject({
      user: expect.objectContaining({ email: "password@example.com" }),
    });
    expect(email.resetUrl).toMatch(
      /^https:\/\/dashboard\.example\.com\/reset-password\?token=/,
    );
  });

  it("does not wait for password reset email delivery", async () => {
    const db = await createTestDb();
    const sendEmail = vi.fn(
      () =>
        new Promise<void>(() => {
          // Intentionally unresolved: request-password-reset must not wait.
        }),
    );
    const auth = createAuth(db, {
      ...OPTS,
      passwordReset: {
        dashboardOrigin: "https://dashboard.example.com",
        sendEmail,
      },
    });
    await seedAuthUser(auth, {
      email: "password@example.com",
      password: "password123",
      name: "Password User",
    });

    const res = await auth.handler(
      new Request("http://localhost:3000/api/auth/request-password-reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "password@example.com" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("does not send or retain reset tokens for SSO-only users", async () => {
    const sendEmail = vi.fn(async (_input: PasswordResetEmailInput) => {});
    const db = await createTestDb();
    const auth = createAuth(db, {
      ...OPTS,
      passwordReset: {
        dashboardOrigin: "https://dashboard.example.com",
        sendEmail,
      },
    });
    const ctx = await auth.$context;
    const created = await ctx.internalAdapter.createUser(
      {
        email: "sso@example.com",
        name: "SSO User",
        emailVerified: true,
      },
      { method: "admin" },
    );
    await seedTestSsoProvider(db, created.id);
    await ctx.internalAdapter.linkAccount({
      userId: created.id,
      providerId: DASHBOARD_SSO_PROVIDER_ID,
      issuer: TEST_SSO_ISSUER,
      accountId: "sso-subject",
    });

    const res = await auth.handler(
      new Request("http://localhost:3000/api/auth/request-password-reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "sso@example.com" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(sendEmail).not.toHaveBeenCalled();
    await expect(userHasCredentialAccount(db, created.id)).resolves.toBe(false);
    const resetTokens = await db
      .select()
      .from(verification)
      .where(like(verification.identifier, "reset-password:%"));
    expect(resetTokens).toHaveLength(0);
  });

  it("consumes reset tokens without creating a new credential path for SSO-only users", async () => {
    const sent: Array<{ token: string }> = [];
    const db = await createTestDb();
    const auth = createAuth(db, {
      ...OPTS,
      passwordReset: {
        dashboardOrigin: "https://dashboard.example.com",
        sendEmail: async ({ token }) => {
          sent.push({ token });
        },
      },
    });
    await seedAuthUser(auth, {
      email: "password@example.com",
      password: "password123",
      name: "Password User",
    });

    await auth.handler(
      new Request("http://localhost:3000/api/auth/request-password-reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "password@example.com" }),
      }),
    );
    expect(sent).toHaveLength(1);
    const reset = sent[0];
    if (!reset) throw new Error("expected password reset token");

    const res = await auth.handler(
      new Request("http://localhost:3000/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: reset.token, newPassword: "newpassword456" }),
      }),
    );
    expect(res.status).toBe(200);

    const oldPassword = await auth.api.signInEmail({
      body: { email: "password@example.com", password: "password123" },
    }).catch((error) => error as Error);
    expect(oldPassword).toBeInstanceOf(Error);

    const newPassword = await auth.api.signInEmail({
      body: { email: "password@example.com", password: "newpassword456" },
      returnHeaders: true,
    });
    expect(tokenFrom(newPassword)).toBeTruthy();
  });
});
