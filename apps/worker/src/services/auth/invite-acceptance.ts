import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { DashboardAuthError } from "@shared/contracts";

import type { Auth } from "./auth-core.js";
import type { Db } from "../../db/client.js";
import { createAuthRepository } from "../../db/repositories/auth.js";
import {
  invitation,
  organization,
} from "../../db/schema.js";
import type { DashboardRole } from "./roles.js";

type AuthContext = Awaited<Auth["$context"]>;
type ExistingUserWithAccounts = NonNullable<
  Awaited<ReturnType<AuthContext["internalAdapter"]["findUserByEmail"]>>
>;
type InviteAcceptanceReadDb = Pick<Db, "select">;
type InvitationRow = typeof invitation.$inferSelect;

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

export type AcceptDashboardSsoInviteInput = {
  organizationSlug: string;
  inviteId: string;
  user: {
    id: string;
    email: string;
  };
  now?: Date;
};

export type DashboardInviteAcceptanceState = {
  inviteId: string;
  email: string;
  organizationName: string;
  role: DashboardRole;
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
  const role = requireInviteRole(invite.role);
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
    role,
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
  const invite = await requireInviteForAcceptance(db, org.id, input.inviteId, now);
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

  const accepted = await createAuthRepository(db).acceptPasswordInvite({
    organizationId: org.id,
    inviteId: invite.id,
    now,
    userId: acceptedUser.id,
    userEmail: acceptedUser.email,
    userName: acceptedUser.name,
    newPasswordHash: acceptedUser.kind === "new" ? acceptedUser.passwordHash : null,
    accountId: acceptedUser.kind === "new" ? randomUUID() : null,
    membershipId: randomUUID(),
  });
  if (!accepted) {
    await throwInviteAcceptanceFailure(db, org.id, invite.id, now);
  }

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

export async function acceptDashboardSsoInvite(
  db: Db,
  _auth: Auth,
  input: AcceptDashboardSsoInviteInput,
): Promise<void> {
  const now = input.now ?? new Date();
  const org = await requireOrganization(db, input.organizationSlug);
  const invite = await requireInviteForAcceptance(db, org.id, input.inviteId, now);
  const normalizedUserEmail = normalizeEmail(input.user.email);
  if (normalizeEmail(invite.email) !== normalizedUserEmail) {
    throw new DashboardAuthError(403, "Invite does not match signed-in user");
  }

  const accepted = await createAuthRepository(db).acceptSsoInvite({
    organizationId: org.id,
    inviteId: invite.id,
    now,
    userId: input.user.id,
    userEmail: normalizedUserEmail,
    membershipId: randomUUID(),
  });
  if (!accepted) {
    await throwInviteAcceptanceFailure(
      db,
      org.id,
      invite.id,
      now,
      normalizedUserEmail,
    );
  }
}

function requireInviteRole(role: string): DashboardRole {
  if (role === "owner" || role === "admin" || role === "member") return role;
  throw new DashboardAuthError(500, "Invalid invite role");
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
  const invite = await findInvite(db, organizationId, inviteId);
  if (!invite || invite.status !== "pending" || invite.expiresAt.getTime() <= now.getTime()) {
    throw new DashboardAuthError(404, "Invite not found");
  }
  return invite;
}

async function requireInviteForAcceptance(
  db: InviteAcceptanceReadDb,
  organizationId: string,
  inviteId: string,
  now: Date,
): Promise<InvitationRow> {
  const invite = await findInvite(db, organizationId, inviteId);
  const stateError = inviteAcceptanceStateError(invite, now);
  if (stateError) throw stateError;
  requireInviteRole(invite!.role);
  return invite!;
}

async function throwInviteAcceptanceFailure(
  db: InviteAcceptanceReadDb,
  organizationId: string,
  inviteId: string,
  now: Date,
  normalizedUserEmail?: string,
): Promise<never> {
  const invite = await findInvite(db, organizationId, inviteId);
  const stateError = inviteAcceptanceStateError(invite, now);
  if (stateError) throw stateError;
  requireInviteRole(invite!.role);
  if (
    normalizedUserEmail !== undefined &&
    normalizeEmail(invite!.email) !== normalizedUserEmail
  ) {
    throw new DashboardAuthError(403, "Invite does not match signed-in user");
  }
  throw new DashboardAuthError(409, "Invite is no longer pending");
}

function inviteAcceptanceStateError(
  invite: InvitationRow | null,
  now: Date,
): DashboardAuthError | null {
  if (!invite) return new DashboardAuthError(404, "Invite not found");
  if (invite.status === "accepted") {
    return new DashboardAuthError(409, "Invite already accepted");
  }
  if (invite.status === "canceled") {
    return new DashboardAuthError(409, "Invite was revoked");
  }
  if (invite.expiresAt.getTime() <= now.getTime()) {
    return new DashboardAuthError(410, "Invite expired");
  }
  if (invite.status !== "pending") {
    return new DashboardAuthError(409, "Invite is no longer pending");
  }
  return null;
}

async function findInvite(
  db: InviteAcceptanceReadDb,
  organizationId: string,
  inviteId: string,
): Promise<InvitationRow | null> {
  const [invite] = await db
    .select()
    .from(invitation)
    .where(and(eq(invitation.organizationId, organizationId), eq(invitation.id, inviteId)))
    .limit(1);
  return invite ?? null;
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

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function sessionTokenFromSignIn(signIn: { headers: Headers; response: unknown }): string {
  return (
    signIn.headers.get("set-auth-token") ??
    (signIn.response as { token?: string }).token ??
    ""
  );
}
