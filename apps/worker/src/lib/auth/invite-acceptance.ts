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
type InviteAcceptanceReadDb = Pick<Db, "select">;
type InviteAcceptanceMembershipDb = Pick<Db, "select" | "insert">;

type AcceptedPasswordUserBase = {
  id: string;
  email: string;
  name: string;
};
type ExistingAcceptedPasswordUser = AcceptedPasswordUserBase & {
  kind: "existing";
};
type NewAcceptedPasswordUser = AcceptedPasswordUserBase & {
  kind: "new";
  passwordHash: string;
};
type AcceptedPasswordUser = ExistingAcceptedPasswordUser | NewAcceptedPasswordUser;

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

export type DashboardInviteAcceptanceState = {
  inviteId: string;
  email: string;
  organizationName: string;
  role: "member";
  mode: "new_user" | "existing_password" | "sso_only";
};

export async function getDashboardInviteAcceptanceState(
  db: Db,
  auth: Auth,
  input: {
    organizationSlug: string;
    inviteId: string;
    now?: Date;
  },
): Promise<DashboardInviteAcceptanceState> {
  const now = input.now ?? new Date();
  const org = await requireOrganization(db, input.organizationSlug);
  const invite = await requirePendingInvite(db, org.id, input.inviteId, now);
  const ctx = await auth.$context;
  const existing = await ctx.internalAdapter.findUserByEmail(invite.email, {
    includeAccounts: true,
  });
  const hasCredential =
    existing?.accounts.some(
      (accountRow) => accountRow.providerId === "credential" && accountRow.password,
    ) ?? false;

  return {
    inviteId: invite.id,
    email: invite.email,
    organizationName: org.name,
    role: "member",
    mode: existing ? (hasCredential ? "existing_password" : "sso_only") : "new_user",
  };
}

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
    : await prepareInvitedPasswordUser(ctx, {
        email: invite.email,
        name: input.name?.trim() || invite.email,
        password: input.password,
      });

  await db.transaction(async (tx) => {
    const currentInvite = await requirePendingInvite(tx, org.id, invite.id, now);
    if (acceptedUser.kind === "new") {
      await tx.insert(user).values({
        id: acceptedUser.id,
        email: acceptedUser.email,
        name: acceptedUser.name,
        emailVerified: true,
      });
      await tx.insert(account).values({
        id: randomUUID(),
        userId: acceptedUser.id,
        providerId: "credential",
        accountId: acceptedUser.id,
        password: acceptedUser.passwordHash,
      });
    }

    await ensureInviteMembership(tx, {
      organizationId: org.id,
      userId: acceptedUser.id,
      role: "member",
    });
    const [accepted] = await tx
      .update(invitation)
      .set({ status: "accepted" })
      .where(and(eq(invitation.id, currentInvite.id), eq(invitation.status, "pending")))
      .returning({ id: invitation.id });
    if (!accepted) {
      throw new DashboardAuthError(409, "Invite is no longer pending");
    }
  });

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
    .select({ id: organization.id, name: organization.name })
    .from(organization)
    .where(eq(organization.slug, slug))
    .limit(1);
  if (!org) throw new DashboardAuthError(404, "Organization not found");
  return org;
}

async function requirePendingInvite(
  db: InviteAcceptanceReadDb,
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
): Promise<AcceptedPasswordUser> {
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
  return {
    kind: "existing",
    id: existing.user.id,
    email: existing.user.email,
    name: existing.user.name,
  };
}

async function prepareInvitedPasswordUser(
  ctx: AuthContext,
  input: { email: string; name: string; password: string },
): Promise<AcceptedPasswordUser> {
  const hash = await ctx.password.hash(input.password);
  return {
    kind: "new",
    id: randomUUID(),
    email: input.email,
    name: input.name,
    passwordHash: hash,
  };
}

async function ensureInviteMembership(
  db: InviteAcceptanceMembershipDb,
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
