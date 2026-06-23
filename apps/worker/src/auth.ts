import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { createError } from "h3";

import type { Db } from "./db/client.js";

export type AuthOptions = {
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
};

/**
 * Build a Better Auth instance over an existing drizzle/Neon db. Pure and
 * env-free so it can be unit-tested against a pglite db. emailAndPassword is
 * enabled but sign-up is disabled (single predefined admin, no registration);
 * the bearer plugin lets the dashboard replay the session token as a Bearer.
 */
export function createAuth(db: Db, options: AuthOptions) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg" }),
    emailAndPassword: { enabled: true, disableSignUp: true },
    plugins: [bearer()],
    trustedOrigins: options.trustedOrigins,
    secret: options.secret,
    baseURL: options.baseURL,
  });
}

export type Auth = ReturnType<typeof createAuth>;

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
  const ctx = await auth.$context;
  const existing = await ctx.internalAdapter.findUserByEmail(creds.email, {
    includeAccounts: true,
  });

  if (!existing) {
    const hash = await ctx.password.hash(creds.password);
    const created = await ctx.internalAdapter.createUser({
      email: creds.email,
      name: creds.name ?? creds.email,
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
  const matches =
    credential?.password != null
      ? await ctx.password.verify({ hash: credential.password, password: creds.password })
      : false;

  if (!matches) {
    const hash = await ctx.password.hash(creds.password);
    await ctx.internalAdapter.updatePassword(existing.user.id, hash);
    return { created: false, updated: true };
  }

  return { created: false, updated: false };
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
