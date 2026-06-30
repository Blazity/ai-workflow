import { randomUUID } from "node:crypto";
import { sso } from "@better-auth/sso";
import { waitUntil } from "@vercel/functions";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, organization as organizationPlugin } from "better-auth/plugins";
import { defaultAc } from "better-auth/plugins/organization/access";
import { and, eq, isNotNull } from "drizzle-orm";
import { createError } from "h3";

import type { Db } from "./db/client.js";
import { account, member, organization, ssoProvider, verification } from "./db/schema.js";

export type AuthOptions = {
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
  passwordReset?: {
    dashboardOrigin: string;
    sendEmail: (input: {
      user: { id: string; email: string; name: string };
      resetUrl: string;
      token: string;
    }) => Promise<void>;
  };
};

export const DASHBOARD_SSO_PROVIDER_ID = "workspace-sso";

const ownerRole = defaultAc.newRole({
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  team: [],
  ac: [],
});

const adminRole = defaultAc.newRole({
  organization: [],
  member: [],
  invitation: ["create", "cancel"],
  team: [],
  ac: [],
});

const memberRole = defaultAc.newRole({
  organization: [],
  member: [],
  invitation: [],
  team: [],
  ac: [],
});

/**
 * Build a Better Auth instance over an existing drizzle/Neon db. Pure and
 * env-free so it can be unit-tested against a pglite db. emailAndPassword is
 * enabled but sign-up is disabled (seeded/invited users only). The bearer
 * plugin lets the dashboard replay the session token as a Bearer.
 */
export function createAuth(db: Db, options: AuthOptions) {
  const passwordReset = options.passwordReset;

  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg" }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      sendResetPassword: passwordReset
        ? async ({ user, token }) => {
            const hasCredential = await userHasCredentialAccount(db, user.id);
            if (!hasCredential) {
              await db
                .delete(verification)
                .where(eq(verification.identifier, `reset-password:${token}`));
              return;
            }

            const promise = passwordReset.sendEmail({
              user,
              token,
              resetUrl: dashboardResetPasswordUrl(passwordReset.dashboardOrigin, token),
            }).catch((error) => {
              console.warn(
                "[dashboard-auth] password reset email failed",
                error instanceof Error ? error.message : error,
              );
            });
            waitUntil(promise);
          }
        : undefined,
    },
    account: {
      accountLinking: {
        enabled: true,
        disableImplicitLinking: false,
        allowDifferentEmails: false,
        requireLocalEmailVerified: true,
        trustedProviders: [DASHBOARD_SSO_PROVIDER_ID],
      },
    },
    plugins: [
      bearer(),
      organizationPlugin({
        allowUserToCreateOrganization: false,
        creatorRole: "owner",
        invitationExpiresIn: 60 * 60 * 48,
        roles: {
          owner: ownerRole,
          admin: adminRole,
          member: memberRole,
        },
        disableOrganizationDeletion: true,
      }),
      sso({
        providersLimit: 10,
        domainVerification: { enabled: true },
        disableImplicitSignUp: false,
        trustEmailVerified: true,
        organizationProvisioning: {
          defaultRole: "member",
        },
      }),
    ],
    trustedOrigins: options.trustedOrigins,
    secret: options.secret,
    baseURL: options.baseURL,
  });
}

export type Auth = ReturnType<typeof createAuth>;

export async function userHasCredentialAccount(db: Db, userId: string): Promise<boolean> {
  const [credential] = await db
    .select({ id: account.id })
    .from(account)
    .where(
      and(
        eq(account.userId, userId),
        eq(account.providerId, "credential"),
        isNotNull(account.password),
      ),
    )
    .limit(1);
  return Boolean(credential);
}

function dashboardResetPasswordUrl(dashboardOrigin: string, token: string): string {
  const origin = dashboardOrigin.replace(/\/$/, "");
  return `${origin}/reset-password?token=${encodeURIComponent(token)}`;
}

export type DashboardSsoConfig = {
  issuer: string;
  allowedDomain: string;
  clientId: string;
  clientSecret: string;
};

export type BootstrapDashboardAuthOptions = {
  owner: {
    email: string;
    password: string;
    name?: string;
  };
  organization: {
    name: string;
    slug: string;
  };
  sso?: DashboardSsoConfig;
};

export type BootstrapDashboardAuthResult = {
  user: { created: boolean; updated: boolean };
  organization: { created: boolean };
  membership: { created: boolean; updated: boolean };
  ssoProvider: { created: boolean; updated: boolean } | null;
};

/**
 * Idempotently ensure the single predefined admin exists with the given
 * password. Uses Better Auth's own context (scrypt hashing + credential
 * account linking) so the seeded login matches the sign-in path exactly.
 * Creates when absent; re-hashes only when the password no longer verifies.
 */
export async function seedAuthUser(
  auth: Auth,
  creds: { email: string; password: string; name?: string },
): Promise<{ created: boolean; updated: boolean }> {
  const email = creds.email.trim().toLowerCase();
  const ctx = await auth.$context;
  const existing = await ctx.internalAdapter.findUserByEmail(email, {
    includeAccounts: true,
  });

  if (!existing) {
    const hash = await ctx.password.hash(creds.password);
    try {
      const created = await ctx.internalAdapter.createUser({
        email,
        name: creds.name ?? email,
        emailVerified: true,
      });
      await ctx.internalAdapter.linkAccount({
        userId: created.id,
        providerId: "credential",
        accountId: created.id,
        password: hash,
      });
      return { created: true, updated: false };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return seedAuthUser(auth, { ...creds, email });
    }
  }

  const credential = existing.accounts.find((a) => a.providerId === "credential");
  const matches = credential?.password
    ? await ctx.password.verify({ hash: credential.password, password: creds.password })
    : false;

  if (!matches) {
    const hash = await ctx.password.hash(creds.password);
    if (!credential) {
      await ctx.internalAdapter.linkAccount({
        userId: existing.user.id,
        providerId: "credential",
        accountId: existing.user.id,
        password: hash,
      });
    } else {
      await ctx.internalAdapter.updatePassword(existing.user.id, hash);
    }
    return { created: false, updated: true };
  }

  return { created: false, updated: false };
}

/**
 * Idempotently prepare the fixed dashboard organization and env-backed SSO
 * provider. This runs without a browser session during deployment bootstrap.
 */
export async function bootstrapDashboardAuth(
  auth: Auth,
  db: Db,
  options: BootstrapDashboardAuthOptions,
): Promise<BootstrapDashboardAuthResult> {
  const userResult = await seedAuthUser(auth, options.owner);
  const ctx = await auth.$context;
  const existingOwner = await ctx.internalAdapter.findUserByEmail(
    options.owner.email.trim().toLowerCase(),
  );

  if (!existingOwner) {
    throw new Error("Dashboard owner was not found after seeding");
  }

  const organizationResult = await ensureDashboardOrganization(db, options.organization);
  const membershipResult = await ensureOwnerMembership(
    db,
    organizationResult.organization.id,
    existingOwner.user.id,
  );
  const ssoProviderResult = options.sso
    ? await ensureSsoProvider(db, organizationResult.organization.id, existingOwner.user.id, options.sso)
    : null;

  return {
    user: userResult,
    organization: { created: organizationResult.created },
    membership: membershipResult,
    ssoProvider: ssoProviderResult,
  };
}

async function ensureDashboardOrganization(
  db: Db,
  input: BootstrapDashboardAuthOptions["organization"],
) {
  const [created] = await db
    .insert(organization)
    .values({
      id: randomUUID(),
      name: input.name,
      slug: input.slug,
    })
    .onConflictDoNothing({ target: organization.slug })
    .returning();

  if (created) {
    return { organization: created, created: true };
  }

  const [existing] = await db
    .select()
    .from(organization)
    .where(eq(organization.slug, input.slug))
    .limit(1);

  if (!existing) {
    throw new Error("Dashboard organization was not found after bootstrap");
  }

  if (existing.name !== input.name) {
    const [updated] = await db
      .update(organization)
      .set({ name: input.name, updatedAt: new Date() })
      .where(eq(organization.id, existing.id))
      .returning();
    return { organization: updated, created: false };
  }

  return { organization: existing, created: false };
}

async function ensureOwnerMembership(
  db: Db,
  organizationId: string,
  userId: string,
): Promise<{ created: boolean; updated: boolean }> {
  const [created] = await db
    .insert(member)
    .values({
      id: randomUUID(),
      organizationId,
      userId,
      role: "owner",
    })
    .onConflictDoNothing({ target: [member.organizationId, member.userId] })
    .returning();

  if (created) {
    return { created: true, updated: false };
  }

  const [existing] = await db
    .select()
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
    .limit(1);

  if (!existing) {
    throw new Error("Dashboard owner membership was not found after bootstrap");
  }

  if (existing.role !== "owner") {
    await db.update(member).set({ role: "owner" }).where(eq(member.id, existing.id));
    return { created: false, updated: true };
  }

  return { created: false, updated: false };
}

async function ensureSsoProvider(
  db: Db,
  organizationId: string,
  userId: string,
  input: DashboardSsoConfig,
): Promise<{ created: boolean; updated: boolean }> {
  const issuer = input.issuer.replace(/\/$/, "");
  const oidcConfig = JSON.stringify({
    issuer,
    pkce: true,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    discoveryEndpoint: `${issuer}/.well-known/openid-configuration`,
    scopes: ["openid", "email", "profile"],
  });

  const providerData = {
    issuer,
    oidcConfig,
    samlConfig: null,
    userId,
    providerId: DASHBOARD_SSO_PROVIDER_ID,
    organizationId,
    domain: input.allowedDomain,
    domainVerified: true,
  };

  const [created] = await db
    .insert(ssoProvider)
    .values({
      id: randomUUID(),
      ...providerData,
    })
    .onConflictDoNothing({ target: ssoProvider.providerId })
    .returning();

  if (created) {
    return { created: true, updated: false };
  }

  const [existing] = await db
    .select()
    .from(ssoProvider)
    .where(eq(ssoProvider.providerId, DASHBOARD_SSO_PROVIDER_ID))
    .limit(1);

  if (!existing) {
    throw new Error("Dashboard SSO provider was not found after bootstrap");
  }

  const changed =
    existing.issuer !== providerData.issuer ||
    existing.oidcConfig !== providerData.oidcConfig ||
    existing.samlConfig !== providerData.samlConfig ||
    existing.userId !== providerData.userId ||
    existing.organizationId !== providerData.organizationId ||
    existing.domain !== providerData.domain ||
    existing.domainVerified !== providerData.domainVerified;

  if (changed) {
    await db
      .update(ssoProvider)
      .set(providerData)
      .where(eq(ssoProvider.providerId, DASHBOARD_SSO_PROVIDER_ID));
    return { created: false, updated: true };
  }

  return { created: false, updated: false };
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybeCode = (error as { code?: unknown }).code;
  if (maybeCode === "23505") return true;
  return error instanceof Error && /duplicate key|unique constraint/i.test(error.message);
}

/**
 * Throw a 401 unless the request carries a valid Better Auth session
 * (`Authorization: Bearer <session-token>`, via the bearer plugin).
 */
export async function assertSession(auth: Auth, headers: Headers): Promise<void> {
  const session = await auth.api.getSession({ headers });
  if (!session) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }
}
