import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import {
  invitation,
  inviteEmailDelivery,
  member as memberTable,
  organization,
  user,
} from "../../db/schema.js";
import {
  createInviteEmailDelivery,
  type InviteEmailDeliveryStatus,
} from "../email/invite-delivery.js";
import { inviteEmailTemplate } from "../email/templates.js";
import { canInvite, type DashboardRole } from "./roles.js";
import { DashboardAuthError, type DashboardActor } from "./users-read.js";

const INVITE_TTL_MS = 48 * 60 * 60 * 1000;

export type SendInviteEmail = (input: {
  to: string;
  subject: string;
  html: string;
  text: string;
  invitationId: string;
  acceptUrl: string;
  expiresAt: Date;
}) => Promise<{ providerMessageId: string }>;

export type DashboardInviteRow = {
  id: string;
  email: string;
  invitedBy: string;
  role: "member";
  status: "pending" | "accepted" | "canceled" | "expired";
  emailStatus: InviteEmailDeliveryStatus | null;
  expiresAt: string | null;
  sentAt: string;
  actions: {
    canResend: boolean;
    canCancel: boolean;
  };
};

export async function createDashboardInvite(
  db: Db,
  input: {
    organizationSlug: string;
    organizationName: string;
    dashboardOrigin: string;
    actor: DashboardActor;
    email: string;
    sendInviteEmail: SendInviteEmail;
    now?: Date;
  },
): Promise<DashboardInviteRow> {
  assertCanManageInvites(input.actor.role);
  const org = await requireOrganization(db, input.organizationSlug);
  const email = normalizeInviteEmail(input.email);
  await assertCanInviteEmail(db, org.id, email);

  const now = input.now ?? new Date();
  const inviteId = randomUUID();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  const acceptUrl = inviteAcceptUrl(input.dashboardOrigin, inviteId);
  const template = inviteEmailTemplate({
    organizationName: input.organizationName,
    inviteUrl: acceptUrl,
  });

  const sendResult = await input.sendInviteEmail({
    ...template,
    to: email,
    invitationId: inviteId,
    acceptUrl,
    expiresAt,
  });

  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(invitation)
      .values({
        id: inviteId,
        organizationId: org.id,
        email,
        role: "member",
        status: "pending",
        expiresAt,
        inviterId: input.actor.userId,
      })
      .returning();

    await createInviteEmailDelivery(tx as Db, {
      invitationId: row.id,
      resendEmailId: sendResult.providerMessageId,
    });

    return row;
  });

  return inviteRowFromRecord(
    {
      ...created,
      inviterName: null,
      inviterEmail: null,
      latestEmailStatus: "queued",
    },
    input.actor.role,
    now,
  );
}

export async function listDashboardInvites(
  db: Db,
  input: {
    organizationSlug: string;
    actorRole: DashboardRole;
    now?: Date;
  },
): Promise<DashboardInviteRow[]> {
  assertCanManageInvites(input.actorRole);
  const org = await requireOrganization(db, input.organizationSlug);
  const now = input.now ?? new Date();

  const rows = await db
    .select({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
      inviterName: user.name,
      inviterEmail: user.email,
    })
    .from(invitation)
    .innerJoin(user, eq(user.id, invitation.inviterId))
    .where(eq(invitation.organizationId, org.id))
    .orderBy(desc(invitation.createdAt));

  const deliveryByInvite = await latestDeliveryByInvitation(db, rows.map((row) => row.id));

  return rows.map((row) =>
    inviteRowFromRecord(
      {
        ...row,
        latestEmailStatus: deliveryByInvite.get(row.id) ?? null,
      },
      input.actorRole,
      now,
    ),
  );
}

export async function resendDashboardInvite(
  db: Db,
  input: {
    organizationSlug: string;
    organizationName: string;
    dashboardOrigin: string;
    actor: DashboardActor;
    inviteId: string;
    sendInviteEmail: SendInviteEmail;
    now?: Date;
  },
): Promise<DashboardInviteRow> {
  assertCanManageInvites(input.actor.role);
  const org = await requireOrganization(db, input.organizationSlug);
  const now = input.now ?? new Date();
  const existing = await requireInvite(db, org.id, input.inviteId);
  const currentStatus = resolvedInviteStatus(existing.status, existing.expiresAt, now);
  if (currentStatus !== "pending" && currentStatus !== "expired") {
    throw new DashboardAuthError(409, "Invite is not pending");
  }

  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  const acceptUrl = inviteAcceptUrl(input.dashboardOrigin, existing.id);
  const template = inviteEmailTemplate({
    organizationName: input.organizationName,
    inviteUrl: acceptUrl,
  });
  const sendResult = await input.sendInviteEmail({
    ...template,
    to: existing.email,
    invitationId: existing.id,
    acceptUrl,
    expiresAt,
  });

  const [updated] = await db
    .update(invitation)
    .set({ expiresAt, status: "pending" })
    .where(eq(invitation.id, existing.id))
    .returning();

  await createInviteEmailDelivery(db, {
    invitationId: updated.id,
    resendEmailId: sendResult.providerMessageId,
  });

  return inviteRowFromRecord(
    {
      ...updated,
      inviterName: null,
      inviterEmail: null,
      latestEmailStatus: "queued",
    },
    input.actor.role,
    now,
  );
}

export async function cancelDashboardInvite(
  db: Db,
  input: {
    organizationSlug: string;
    actor: DashboardActor;
    inviteId: string;
    now?: Date;
  },
): Promise<DashboardInviteRow> {
  assertCanManageInvites(input.actor.role);
  const org = await requireOrganization(db, input.organizationSlug);
  const now = input.now ?? new Date();
  const existing = await requireInvite(db, org.id, input.inviteId);
  const currentStatus = resolvedInviteStatus(existing.status, existing.expiresAt, now);
  if (currentStatus !== "pending" && currentStatus !== "expired") {
    throw new DashboardAuthError(409, "Invite is not pending");
  }

  const [updated] = await db
    .update(invitation)
    .set({ status: "canceled" })
    .where(eq(invitation.id, existing.id))
    .returning();

  return inviteRowFromRecord(
    {
      ...updated,
      inviterName: null,
      inviterEmail: null,
      latestEmailStatus: null,
    },
    input.actor.role,
    now,
  );
}

function assertCanManageInvites(role: DashboardRole): void {
  if (!canInvite(role)) {
    throw new DashboardAuthError(403, "Forbidden");
  }
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

async function requireInvite(db: Db, organizationId: string, inviteId: string) {
  const [row] = await db
    .select()
    .from(invitation)
    .where(and(eq(invitation.organizationId, organizationId), eq(invitation.id, inviteId)))
    .limit(1);
  if (!row) throw new DashboardAuthError(404, "Invite not found");
  return row;
}

async function assertCanInviteEmail(
  db: Db,
  organizationId: string,
  email: string,
): Promise<void> {
  const [existingUser] = await db
    .select({ id: user.id })
    .from(user)
    .innerJoin(memberTable, eq(memberTable.userId, user.id))
    .where(and(eq(memberTable.organizationId, organizationId), eq(user.email, email)))
    .limit(1);
  if (existingUser) {
    throw new DashboardAuthError(409, "User is already a member");
  }

  const [existingInvite] = await db
    .select({ id: invitation.id })
    .from(invitation)
    .where(
      and(
        eq(invitation.organizationId, organizationId),
        eq(invitation.email, email),
        eq(invitation.status, "pending"),
      ),
    )
    .limit(1);
  if (existingInvite) {
    throw new DashboardAuthError(409, "User is already invited");
  }
}

async function latestDeliveryByInvitation(
  db: Db,
  invitationIds: string[],
): Promise<Map<string, InviteEmailDeliveryStatus>> {
  if (invitationIds.length === 0) return new Map();
  const rows = await db
    .select({
      invitationId: inviteEmailDelivery.invitationId,
      status: inviteEmailDelivery.status,
      createdAt: inviteEmailDelivery.createdAt,
    })
    .from(inviteEmailDelivery)
    .where(inArray(inviteEmailDelivery.invitationId, invitationIds))
    .orderBy(desc(inviteEmailDelivery.createdAt));

  const byInvite = new Map<string, InviteEmailDeliveryStatus>();
  for (const row of rows) {
    if (!byInvite.has(row.invitationId)) {
      byInvite.set(row.invitationId, row.status as InviteEmailDeliveryStatus);
    }
  }
  return byInvite;
}

function inviteRowFromRecord(
  row: {
    id: string;
    email: string;
    role: string;
    status: string;
    expiresAt: Date;
    createdAt: Date;
    inviterName: string | null;
    inviterEmail: string | null;
    latestEmailStatus: InviteEmailDeliveryStatus | null;
  },
  actorRole: DashboardRole,
  now: Date,
): DashboardInviteRow {
  const status = resolvedInviteStatus(row.status, row.expiresAt, now);
  const manageable = canInvite(actorRole) && (status === "pending" || status === "expired");
  return {
    id: row.id,
    email: row.email,
    invitedBy: row.inviterName || row.inviterEmail || "Unknown",
    role: "member",
    status,
    emailStatus: row.latestEmailStatus,
    expiresAt: row.expiresAt.toISOString(),
    sentAt: row.createdAt.toISOString(),
    actions: {
      canResend: manageable,
      canCancel: manageable,
    },
  };
}

function resolvedInviteStatus(
  status: string,
  expiresAt: Date,
  now: Date,
): DashboardInviteRow["status"] {
  if (status === "pending" && expiresAt.getTime() <= now.getTime()) return "expired";
  if (status === "accepted") return "accepted";
  if (status === "canceled" || status === "cancelled") return "canceled";
  return "pending";
}

function inviteAcceptUrl(dashboardOrigin: string, inviteId: string): string {
  const origin = dashboardOrigin.replace(/\/$/, "");
  return `${origin}/invite/accept?id=${encodeURIComponent(inviteId)}`;
}

function normalizeInviteEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw new DashboardAuthError(400, "Invalid email");
  }
  return normalized;
}
