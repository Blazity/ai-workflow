import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import {
  account,
  member as memberTable,
  organization,
  user,
} from "../../db/schema.js";
import {
  canChangeRole,
  normalizeDashboardRole,
  type DashboardRole,
} from "./roles.js";

export type DashboardAuthMethod = "Password" | "SSO" | "Password + SSO" | "Unknown";

export type DashboardActor = {
  organizationId: string;
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

export class DashboardAuthError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export async function getDashboardActor(
  db: Db,
  input: { organizationSlug: string; userId: string },
): Promise<DashboardActor | null> {
  const org = await findOrganizationBySlug(db, input.organizationSlug);
  if (!org) return null;

  const [membership] = await db
    .select({
      id: memberTable.id,
      role: memberTable.role,
      userId: memberTable.userId,
    })
    .from(memberTable)
    .where(
      and(
        eq(memberTable.organizationId, org.id),
        eq(memberTable.userId, input.userId),
      ),
    )
    .limit(1);

  const role = membership ? normalizeDashboardRole(membership.role) : null;
  if (!membership || !role) return null;

  return {
    organizationId: org.id,
    memberId: membership.id,
    userId: membership.userId,
    role,
  };
}

export async function listDashboardUsers(
  db: Db,
  input: { organizationSlug: string; actorRole: DashboardRole },
): Promise<DashboardUserRow[]> {
  const org = await findOrganizationBySlug(db, input.organizationSlug);
  if (!org) return [];

  const rows = await db
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      role: memberTable.role,
      joinedAt: memberTable.createdAt,
    })
    .from(memberTable)
    .innerJoin(user, eq(user.id, memberTable.userId))
    .where(eq(memberTable.organizationId, org.id))
    .orderBy(asc(user.email));

  const userIds = rows.map((row) => row.userId);
  const accounts =
    userIds.length === 0
      ? []
      : await db
          .select({
            userId: account.userId,
            providerId: account.providerId,
          })
          .from(account)
          .where(inArray(account.userId, userIds));
  const providersByUser = new Map<string, Set<string>>();
  for (const accountRow of accounts) {
    const providers = providersByUser.get(accountRow.userId) ?? new Set<string>();
    providers.add(accountRow.providerId);
    providersByUser.set(accountRow.userId, providers);
  }

  return rows.map((row) => {
    const role = normalizeDashboardRole(row.role) ?? "member";
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
  const org = await findOrganizationBySlug(db, input.organizationSlug);
  if (!org) {
    throw new DashboardAuthError(404, "Organization not found");
  }

  const [target] = await db
    .select({
      id: memberTable.id,
      role: memberTable.role,
      userId: memberTable.userId,
    })
    .from(memberTable)
    .where(
      and(
        eq(memberTable.organizationId, org.id),
        eq(memberTable.userId, input.targetUserId),
      ),
    )
    .limit(1);

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

  await db
    .update(memberTable)
    .set({ role: input.nextRole })
    .where(eq(memberTable.id, target.id));

  return { userId: target.userId, role: input.nextRole };
}

async function findOrganizationBySlug(db: Db, slug: string) {
  const [org] = await db
    .select({ id: organization.id, slug: organization.slug })
    .from(organization)
    .where(eq(organization.slug, slug))
    .limit(1);
  return org ?? null;
}

function authMethodForProviders(providers: Set<string> | undefined): DashboardAuthMethod {
  if (!providers || providers.size === 0) return "Unknown";
  const hasPassword = providers?.has("credential") ?? false;
  const hasSso = [...(providers ?? [])].some((provider) => provider !== "credential");
  if (hasPassword && hasSso) return "Password + SSO";
  if (hasSso) return "SSO";
  return "Password";
}
