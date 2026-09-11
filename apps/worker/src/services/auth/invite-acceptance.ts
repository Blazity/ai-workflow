import { randomUUID } from "node:crypto";
import { DashboardAuthError } from "@shared/contracts";
import type { Auth } from "./auth-core.js";
import type { Db } from "../../db/types.js";
import { createAuthRepository, createConnectedAuthRepository } from "../../db/repositories/auth.js";
import type { DashboardRole } from "./roles.js";

type AuthContext = Awaited<Auth["$context"]>;
type ExistingUserWithAccounts = NonNullable<
  Awaited<ReturnType<AuthContext["internalAdapter"]["findUserByEmail"]>>
>;
type AuthRepository = ReturnType<typeof createAuthRepository>;
type InvitationRow = NonNullable<Awaited<ReturnType<AuthRepository["findOrganizationInvite"]>>>;

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
  return getDashboardInviteAcceptanceStateFromRepository(createAuthRepository(db), auth, input);
}

export function getConnectedDashboardInviteAcceptanceState(
  auth: Auth,
  input: {
    organizationSlug: string;
    inviteId: string;
    now?: Date;
  },
): Promise<DashboardInviteAcceptanceState> {
  return getDashboardInviteAcceptanceStateFromRepository(createConnectedAuthRepository(), auth, input);
}

async function getDashboardInviteAcceptanceStateFromRepository(
  repository: AuthRepository,
  auth: Auth,
  input: {
    organizationSlug: string;
    inviteId: string;
    now?: Date;
  },
): Promise<DashboardInviteAcceptanceState> {
  const now = input.now ?? new Date();
  const org = await requireOrganization(repository, input.organizationSlug);
  const invite = await requireInviteForAcceptance(repository, org.id, input.inviteId, now);
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
  return acceptDashboardInviteFromRepository(createAuthRepository(db), auth, input);
}

export function acceptConnectedDashboardInvite(
  auth: Auth,
  input: AcceptDashboardInviteInput,
): Promise<AcceptDashboardInviteResult> {
  return acceptDashboardInviteFromRepository(createConnectedAuthRepository(), auth, input);
}

async function acceptDashboardInviteFromRepository(
  repository: AuthRepository,
  auth: Auth,
  input: AcceptDashboardInviteInput,
): Promise<AcceptDashboardInviteResult> {
  const now = input.now ?? new Date();
  const org = await requireOrganization(repository, input.organizationSlug);
  const invite = await requireInviteForAcceptance(repository, org.id, input.inviteId, now);
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

  const accepted = await repository.acceptPasswordInvite({
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
    await throwInviteAcceptanceFailure(repository, org.id, invite.id, now);
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
  return acceptDashboardSsoInviteFromRepository(createAuthRepository(db), _auth, input);
}

export function acceptConnectedDashboardSsoInvite(
  auth: Auth,
  input: AcceptDashboardSsoInviteInput,
): Promise<void> {
  return acceptDashboardSsoInviteFromRepository(createConnectedAuthRepository(), auth, input);
}

async function acceptDashboardSsoInviteFromRepository(
  repository: AuthRepository,
  _auth: Auth,
  input: AcceptDashboardSsoInviteInput,
): Promise<void> {
  const now = input.now ?? new Date();
  const org = await requireOrganization(repository, input.organizationSlug);
  const normalizedUserEmail = normalizeEmail(input.user.email);
  let invite: InvitationRow;
  try {
    invite = await requireInviteForAcceptance(
      repository,
      org.id,
      input.inviteId,
      now,
      normalizedUserEmail,
    );
  } catch (error) {
    if (!isAlreadyAcceptedInvite(error)) throw error;
    const membership = await repository.findOrganizationMembership({
      organizationId: org.id,
      userId: input.user.id,
    });
    if (membership) return;
    throw error;
  }

  const accepted = await repository.acceptSsoInvite({
    organizationId: org.id,
    inviteId: invite.id,
    now,
    userId: input.user.id,
    userEmail: normalizedUserEmail,
    membershipId: randomUUID(),
  });
  if (!accepted) {
    await throwInviteAcceptanceFailure(
      repository,
      org.id,
      invite.id,
      now,
      normalizedUserEmail,
    );
  }
}

function isAlreadyAcceptedInvite(error: unknown): boolean {
  return error instanceof DashboardAuthError &&
    error.statusCode === 409 &&
    error.message === "Invite already accepted";
}

function requireInviteRole(role: string): DashboardRole {
  if (role === "owner" || role === "admin" || role === "member") return role;
  throw new DashboardAuthError(500, "Invalid invite role");
}

async function requireOrganization(repository: AuthRepository, slug: string) {
  const org = await repository.findOrganizationBySlug(slug);
  if (!org) throw new DashboardAuthError(404, "Organization not found");
  return org;
}

async function requireInviteForAcceptance(
  repository: AuthRepository,
  organizationId: string,
  inviteId: string,
  now: Date,
  normalizedUserEmail?: string,
): Promise<InvitationRow> {
  const invite = await findInvite(repository, organizationId, inviteId);
  if (
    invite &&
    normalizedUserEmail !== undefined &&
    normalizeEmail(invite.email) !== normalizedUserEmail
  ) {
    throw new DashboardAuthError(403, "Invite does not match signed-in user");
  }
  const stateError = inviteAcceptanceStateError(invite, now);
  if (stateError) throw stateError;
  requireInviteRole(invite!.role);
  return invite!;
}

async function throwInviteAcceptanceFailure(
  repository: AuthRepository,
  organizationId: string,
  inviteId: string,
  now: Date,
  normalizedUserEmail?: string,
): Promise<never> {
  const invite = await findInvite(repository, organizationId, inviteId);
  if (
    invite &&
    normalizedUserEmail !== undefined &&
    normalizeEmail(invite!.email) !== normalizedUserEmail
  ) {
    throw new DashboardAuthError(403, "Invite does not match signed-in user");
  }
  const stateError = inviteAcceptanceStateError(invite, now);
  if (stateError) throw stateError;
  requireInviteRole(invite!.role);
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
  repository: AuthRepository,
  organizationId: string,
  inviteId: string,
): Promise<InvitationRow | null> {
  return repository.findOrganizationInvite({ organizationId, inviteId });
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
