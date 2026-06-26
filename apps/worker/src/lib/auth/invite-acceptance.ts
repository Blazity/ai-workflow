import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import type { Auth } from "../../auth.js";
import type { Db } from "../../db/client.js";
import {
  account,
  invitation,
  member as memberTable,
  organization,
  user,
} from "../../db/schema.js";
import { DashboardAuthError } from "./users-read.js";

type AuthContext = Awaited<Auth["$context"]>;
type ExistingUserWithAccounts = NonNullable<
  Awaited<ReturnType<AuthContext["internalAdapter"]["findUserByEmail"]>>
>;

export type AcceptDashboardInviteInput = {
  organizationSlug: string;
  inviteId: string;
  name?: string;
  password: string;
  now?: Date;
};

export type AcceptDashboardInviteResult = {
  token: string;
  user: {
    id: string;
    email: string;
    name: string;
  };
};

export async function acceptDashboardInvite(
  db: Db,
  auth: Auth,
  input: AcceptDashboardInviteInput,
): Promise<AcceptDashboardInviteResult> {
  const now = input.now ?? new Date();
  const org = await requireOrganization(db, input.organizationSlug);
  const invite = await requirePendingInvite(db, org.id, input.inviteId, now);
  const ctx = await auth.$context;

  assertPasswordLength(input.password, ctx.password.config);
  const existing = await ctx.internalAdapter.findUserByEmail(invite.email, {
    includeAccounts: true,
  });

  const acceptedUser = existing
    ? await requireExistingPasswordUser(ctx, existing, input.password)
    : await createInvitedPasswordUser(ctx, {
        email: invite.email,
        name: input.name?.trim() || invite.email,
        password: input.password,
      });

  await ensureInviteMembership(db, {
    organizationId: org.id,
    userId: acceptedUser.id,
    role: "member",
  });
  await db
    .update(invitation)
    .set({ status: "accepted" })
    .where(and(eq(invitation.id, invite.id), eq(invitation.status, "pending")));

  const signIn = await auth.api.signInEmail({
    body: { email: invite.email, password: input.password },
    returnHeaders: true,
  });
  const token = sessionTokenFromSignIn(signIn);
  if (!token) {
    throw new DashboardAuthError(502, "Auth session was not created");
  }

  return {
    token,
    user: {
      id: acceptedUser.id,
      email: acceptedUser.email,
      name: acceptedUser.name,
    },
  };
}

async function requireOrganization(db: Db, slug: string) {
  const [org] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, slug))
    .limit(1);
  if (!org) throw new DashboardAuthError(404, "Organization not found");
  return org;
}

async function requirePendingInvite(
  db: Db,
  organizationId: string,
  inviteId: string,
  now: Date,
) {
  const [invite] = await db
    .select()
    .from(invitation)
    .where(and(eq(invitation.organizationId, organizationId), eq(invitation.id, inviteId)))
    .limit(1);
  if (!invite || invite.status !== "pending" || invite.expiresAt.getTime() <= now.getTime()) {
    throw new DashboardAuthError(404, "Invite not found");
  }
  return invite;
}

function assertPasswordLength(
  password: string,
  config: { minPasswordLength?: number; maxPasswordLength?: number },
): void {
  const min = config.minPasswordLength ?? 8;
  const max = config.maxPasswordLength ?? 128;
  if (password.length < min) {
    throw new DashboardAuthError(400, "Password is too short");
  }
  if (password.length > max) {
    throw new DashboardAuthError(400, "Password is too long");
  }
}

async function requireExistingPasswordUser(
  ctx: AuthContext,
  existing: ExistingUserWithAccounts,
  password: string,
) {
  const credential = existing.accounts.find(
    (accountRow) => accountRow.providerId === "credential" && accountRow.password,
  );
  if (!credential?.password) {
    throw new DashboardAuthError(409, "Use SSO to sign in");
  }

  const valid = await ctx.password.verify({ hash: credential.password, password });
  if (!valid) {
    throw new DashboardAuthError(401, "Invalid credentials");
  }
  return existing.user;
}

async function createInvitedPasswordUser(
  ctx: AuthContext,
  input: { email: string; name: string; password: string },
) {
  const hash = await ctx.password.hash(input.password);
  const created = await ctx.internalAdapter.createUser({
    email: input.email,
    name: input.name,
    emailVerified: true,
  });
  await ctx.internalAdapter.linkAccount({
    userId: created.id,
    providerId: "credential",
    accountId: created.id,
    password: hash,
  });
  return created;
}

async function ensureInviteMembership(
  db: Db,
  input: { organizationId: string; userId: string; role: "member" },
): Promise<void> {
  const [existing] = await db
    .select({ id: memberTable.id })
    .from(memberTable)
    .where(
      and(
        eq(memberTable.organizationId, input.organizationId),
        eq(memberTable.userId, input.userId),
      ),
    )
    .limit(1);
  if (existing) return;

  await db.insert(memberTable).values({
    id: randomUUID(),
    organizationId: input.organizationId,
    userId: input.userId,
    role: input.role,
  });
}

function sessionTokenFromSignIn(signIn: { headers: Headers; response: unknown }): string {
  return (
    signIn.headers.get("set-auth-token") ??
    (signIn.response as { token?: string }).token ??
    ""
  );
}
