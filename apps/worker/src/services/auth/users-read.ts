import type { Db } from "../../db/types.js";
import { DashboardAuthError } from "@shared/contracts";
import { createAuthRepository, createConnectedAuthRepository } from "../../db/repositories/auth.js";
import {
  canChangeRole,
  normalizeDashboardRole,
  type DashboardRole,
} from "./roles.js";

type DashboardAuthMethod = "Password" | "SSO" | "Password + SSO" | "Unknown";

export type DashboardActor = {
  organizationId: string;
  organizationName: string;
  memberId: string;
  userId: string;
  role: DashboardRole;
};

export type DashboardUserRow = {
  id: string;
  name: string;
  email: string;
  role: DashboardRole;
  authMethod: DashboardAuthMethod;
  joinedAt: string;
  actions: {
    canPromote: boolean;
    canDemote: boolean;
  };
};

export async function dashboardUserLabel(db: Db, userId: string): Promise<string> {
  return createAuthRepository(db).dashboardUserLabel(userId);
}

export function getConnectedDashboardUserLabel(userId: string): Promise<string> {
  return createConnectedAuthRepository().dashboardUserLabel(userId);
}

export async function getDashboardActor(
  db: Db,
  input: { organizationSlug: string; userId: string },
): Promise<DashboardActor | null> {
  return getDashboardActorFromRepository(createAuthRepository(db), input);
}

export function getConnectedDashboardActor(
  input: { organizationSlug: string; userId: string },
): Promise<DashboardActor | null> {
  return getDashboardActorFromRepository(createConnectedAuthRepository(), input);
}

async function getDashboardActorFromRepository(
  repository: ReturnType<typeof createAuthRepository>,
  input: { organizationSlug: string; userId: string },
): Promise<DashboardActor | null> {
  const org = await repository.findOrganizationBySlug(input.organizationSlug);
  if (!org) return null;
  const membership = await repository.findOrganizationMembership({
    organizationId: org.id,
    userId: input.userId,
  });

  const role = membership ? normalizeDashboardRole(membership.role) : null;
  if (!membership || !role) return null;

  return {
    organizationId: org.id,
    organizationName: org.name,
    memberId: membership.id,
    userId: membership.userId,
    role,
  };
}

export async function listDashboardUsers(
  db: Db,
  input: { organizationSlug: string; actorRole: DashboardRole },
): Promise<DashboardUserRow[]> {
  return listDashboardUsersFromRepository(createAuthRepository(db), input);
}

export function listConnectedDashboardUsers(
  input: { organizationSlug: string; actorRole: DashboardRole },
): Promise<DashboardUserRow[]> {
  return listDashboardUsersFromRepository(createConnectedAuthRepository(), input);
}

async function listDashboardUsersFromRepository(
  repository: ReturnType<typeof createAuthRepository>,
  input: { organizationSlug: string; actorRole: DashboardRole },
): Promise<DashboardUserRow[]> {
  const org = await repository.findOrganizationBySlug(input.organizationSlug);
  if (!org) return [];
  const rows = await repository.listOrganizationMembers(org.id);
  const accounts = await repository.listAccountProviders(rows.map((row) => row.userId));
  const providersByUser = new Map<string, Set<string>>();
  for (const accountRow of accounts) {
    const providers = providersByUser.get(accountRow.userId) ?? new Set<string>();
    providers.add(accountRow.providerId);
    providersByUser.set(accountRow.userId, providers);
  }

  return rows.map((row) => {
    const role = normalizeDashboardRole(row.role);
    if (!role) {
      throw new DashboardAuthError(500, "Invalid dashboard role");
    }

    return {
      id: row.userId,
      name: row.name,
      email: row.email,
      role,
      authMethod: authMethodForProviders(providersByUser.get(row.userId)),
      joinedAt: row.joinedAt.toISOString(),
      actions: {
        canPromote:
          role === "member" &&
          canChangeRole({ actor: input.actorRole, target: role, next: "admin" }),
        canDemote:
          role === "admin" &&
          canChangeRole({ actor: input.actorRole, target: role, next: "member" }),
      },
    };
  });
}

export async function updateDashboardUserRole(
  db: Db,
  input: {
    organizationSlug: string;
    actorRole: DashboardRole;
    targetUserId: string;
    nextRole: Exclude<DashboardRole, "owner">;
  },
): Promise<{ userId: string; role: Exclude<DashboardRole, "owner"> }> {
  return updateDashboardUserRoleFromRepository(createAuthRepository(db), input);
}

export function updateConnectedDashboardUserRole(
  input: {
    organizationSlug: string;
    actorRole: DashboardRole;
    targetUserId: string;
    nextRole: Exclude<DashboardRole, "owner">;
  },
): Promise<{ userId: string; role: Exclude<DashboardRole, "owner"> }> {
  return updateDashboardUserRoleFromRepository(createConnectedAuthRepository(), input);
}

async function updateDashboardUserRoleFromRepository(
  repository: ReturnType<typeof createAuthRepository>,
  input: {
    organizationSlug: string;
    actorRole: DashboardRole;
    targetUserId: string;
    nextRole: Exclude<DashboardRole, "owner">;
  },
): Promise<{ userId: string; role: Exclude<DashboardRole, "owner"> }> {
  const org = await repository.findOrganizationBySlug(input.organizationSlug);
  if (!org) {
    throw new DashboardAuthError(404, "Organization not found");
  }

  const target = await repository.findOrganizationMembership({
    organizationId: org.id,
    userId: input.targetUserId,
  });

  const targetRole = target ? normalizeDashboardRole(target.role) : null;
  if (!target || !targetRole) {
    throw new DashboardAuthError(404, "Member not found");
  }

  if (
    !canChangeRole({
      actor: input.actorRole,
      target: targetRole,
      next: input.nextRole,
    })
  ) {
    throw new DashboardAuthError(403, "Forbidden");
  }

  await repository.updateMemberRole(target.id, input.nextRole);

  return { userId: target.userId, role: input.nextRole };
}

function authMethodForProviders(providers: Set<string> | undefined): DashboardAuthMethod {
  if (!providers || providers.size === 0) return "Unknown";
  const hasPassword = providers?.has("credential") ?? false;
  const hasSso = [...(providers ?? [])].some((provider) => provider !== "credential");
  if (hasPassword && hasSso) return "Password + SSO";
  if (hasSso) return "SSO";
  return "Password";
}
