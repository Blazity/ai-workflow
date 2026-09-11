import { sso } from "@better-auth/sso";
import { waitUntil } from "@vercel/functions";
import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import {
  bearer,
  jwt,
  oneTimeToken,
  organization as organizationPlugin,
} from "better-auth/plugins";
import { defaultAc } from "better-auth/plugins/organization/access";
import { createError } from "h3";

import type { Db } from "../../db/client.js";
import {
  createAuthRepository,
  createBetterAuthAdapter,
} from "../../db/repositories/auth.js";
import { createMcpOAuthProvider, validateMcpOAuthHookRequest } from "./mcp-oauth-provider.js";

export type AuthOptions = {
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
  mcp?: {
    organizationId?: string;
    organizationSlug?: string;
    allowPublicDcr?: boolean;
  };
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
  const mcpDeployment = options.mcp
    ? { ...options.mcp, baseURL: options.baseURL, db }
    : null;

  return betterAuth({
    database: createBetterAuthAdapter(db),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      sendResetPassword: passwordReset
        ? async ({ user, token }) => {
            const hasCredential = await userHasCredentialAccount(db, user.id);
            if (!hasCredential) {
              await createAuthRepository(db).deleteResetPasswordVerification(token);
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
    hooks: mcpDeployment
      ? {
          before: createAuthMiddleware(async (ctx) => {
            await validateMcpOAuthHookRequest(
              mcpDeployment,
              ctx.path,
              ctx.body as Record<string, unknown> | undefined,
              ctx.request?.headers.get("authorization"),
            );
          }),
        }
      : undefined,
    plugins: [
      bearer(),
      oneTimeToken({
        disableClientRequest: true,
        expiresIn: 1,
        storeToken: "hashed",
      }),
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
      ...(mcpDeployment ? [jwt(), createMcpOAuthProvider(mcpDeployment)] : []),
    ],
    trustedOrigins: options.trustedOrigins,
    secret: options.secret,
    baseURL: options.baseURL,
  });
}

export type Auth = ReturnType<typeof createAuth>;
type AuthContext = Awaited<Auth["$context"]>;

const AUTH_SEED_MAX_ATTEMPTS = 3;

export function userHasCredentialAccount(db: Db, userId: string): Promise<boolean> {
  return createAuthRepository(db).hasCredentialAccount(userId);
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
  return retryOnUniqueViolation(() => seedAuthUserOnce(ctx, { ...creds, email }));
}

async function seedAuthUserOnce(
  ctx: AuthContext,
  creds: { email: string; password: string; name?: string },
): Promise<{ created: boolean; updated: boolean }> {
  const email = creds.email;
  const existing = await ctx.internalAdapter.findUserByEmail(email, {
    includeAccounts: true,
  });

  if (!existing) {
    const hash = await ctx.password.hash(creds.password);
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

async function retryOnUniqueViolation<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < AUTH_SEED_MAX_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === AUTH_SEED_MAX_ATTEMPTS - 1) {
        throw error;
      }
    }
  }

  throw new Error("Unreachable auth seed retry state");
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

function ensureDashboardOrganization(
  db: Db,
  input: BootstrapDashboardAuthOptions["organization"],
) {
  return createAuthRepository(db).ensureOrganization(input);
}

function ensureOwnerMembership(
  db: Db,
  organizationId: string,
  userId: string,
): Promise<{ created: boolean; updated: boolean }> {
  return createAuthRepository(db).ensureOwnerMembership(organizationId, userId);
}

function ensureSsoProvider(
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

  return createAuthRepository(db).ensureSsoProvider({
    issuer,
    oidcConfig,
    userId,
    providerId: DASHBOARD_SSO_PROVIDER_ID,
    organizationId,
    domain: input.allowedDomain,
  });
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybeCode = (error as { code?: unknown }).code;
  if (maybeCode === "23505") return true;
  if (error instanceof Error && /duplicate key|unique constraint/i.test(error.message)) {
    return true;
  }
  return isUniqueViolation((error as { cause?: unknown }).cause);
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
