import { and, eq, like } from "drizzle-orm";
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
import { member, organization, ssoProvider, user, verification } from "./db/schema.js";

const OPTS = {
  secret: "x".repeat(32),
  baseURL: "http://localhost:3000",
  trustedOrigins: ["http://localhost:3001"],
};

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
    });
    expect(JSON.parse(providers[0].oidcConfig ?? "{}")).toMatchObject({
      issuer: "https://idp.acme.test",
      clientId: "client-id-2",
      clientSecret: "client-secret-2",
      pkce: true,
      scopes: ["openid", "email", "profile"],
    });
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
    const created = await ctx.internalAdapter.createUser({
      email: "sso@example.com",
      name: "SSO User",
      emailVerified: true,
    });
    await ctx.internalAdapter.linkAccount({
      userId: created.id,
      providerId: DASHBOARD_SSO_PROVIDER_ID,
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
