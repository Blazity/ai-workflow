import { randomUUID } from "node:crypto";
import type { Db } from "../../db/types.js";
import {
  createAuthRepository,
  createConnectedAuthRepository,
} from "../../db/repositories/auth.js";
import {
  createConnectedInviteEmailDeliveryRepository,
  createInviteEmailDeliveryRepository,
  type InviteEmailDeliveryStatus,
} from "../../db/repositories/invite-email-deliveries.js";
import { inviteEmailTemplate } from "../email/templates.js";
import { canInvite, type DashboardRole } from "./roles.js";
import { DashboardAuthError, type DashboardActor } from "./users-read.js";

type AuthRepository = ReturnType<typeof createAuthRepository>;
type InviteEmailDeliveryRepository = ReturnType<typeof createInviteEmailDeliveryRepository>;

const INVITE_TTL_MS = 48 * 60 * 60 * 1000;

export type SendInviteEmail = (input: {
  to: string;
  subject: string;
  html: string;
  text: string;
  invitationId: string;
  deliveryId: string;
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
  return createDashboardInviteFromRepositories(
    createAuthRepository(db),
    createInviteEmailDeliveryRepository(db),
    input,
  );
}

export function createConnectedDashboardInvite(
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
  return createDashboardInviteFromRepositories(
    createConnectedAuthRepository(),
    createConnectedInviteEmailDeliveryRepository(),
    input,
  );
}

async function createDashboardInviteFromRepositories(
  repository: AuthRepository,
  deliveries: InviteEmailDeliveryRepository,
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
  const org = await requireOrganization(repository, input.organizationSlug);
  assertActorInOrganization(input.actor, org.id);
  const email = normalizeInviteEmail(input.email);
  await assertCanInviteEmail(repository, org.id, email);

  const now = input.now ?? new Date();
  const inviteId = randomUUID();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  const acceptUrl = inviteAcceptUrl(input.dashboardOrigin, inviteId);
  const template = inviteEmailTemplate({
    organizationName: input.organizationName,
    inviteUrl: acceptUrl,
  });
  const deliveryId = randomUUID();

  const created = await repository.createInviteWithDelivery({
    inviteId,
    deliveryId,
    organizationId: org.id,
    email,
    expiresAt,
    inviterId: input.actor.userId,
  });

  let sendResult: { providerMessageId: string };
  try {
    sendResult = await input.sendInviteEmail({
      ...template,
      to: email,
      invitationId: inviteId,
      deliveryId,
      acceptUrl,
      expiresAt,
    });
  } catch (error) {
    await deliveries.updateById({
      id: deliveryId,
      status: "failed",
      error: messageFromUnknown(error),
    });
    throw error;
  }

  await recordProviderAcceptedDelivery(deliveries, deliveryId, sendResult.providerMessageId);

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
    actor: DashboardActor;
    now?: Date;
  },
): Promise<DashboardInviteRow[]> {
  return listDashboardInvitesFromRepository(createAuthRepository(db), input);
}

export function listConnectedDashboardInvites(
  input: {
    organizationSlug: string;
    actor: DashboardActor;
    now?: Date;
  },
): Promise<DashboardInviteRow[]> {
  return listDashboardInvitesFromRepository(createConnectedAuthRepository(), input);
}

async function listDashboardInvitesFromRepository(
  repository: AuthRepository,
  input: {
    organizationSlug: string;
    actor: DashboardActor;
    now?: Date;
  },
): Promise<DashboardInviteRow[]> {
  assertCanManageInvites(input.actor.role);
  const org = await requireOrganization(repository, input.organizationSlug);
  assertActorInOrganization(input.actor, org.id);
  const now = input.now ?? new Date();

  const rows = await repository.listOrganizationInvites(org.id);

  const deliveryByInvite = await latestDeliveryByInvitation(repository, rows.map((row) => row.id));

  return rows.map((row) =>
    inviteRowFromRecord(
      {
        ...row,
        latestEmailStatus: deliveryByInvite.get(row.id) ?? null,
      },
      input.actor.role,
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
  return resendDashboardInviteFromRepositories(
    createAuthRepository(db),
    createInviteEmailDeliveryRepository(db),
    input,
  );
}

export function resendConnectedDashboardInvite(
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
  return resendDashboardInviteFromRepositories(
    createConnectedAuthRepository(),
    createConnectedInviteEmailDeliveryRepository(),
    input,
  );
}

async function resendDashboardInviteFromRepositories(
  repository: AuthRepository,
  deliveries: InviteEmailDeliveryRepository,
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
  const org = await requireOrganization(repository, input.organizationSlug);
  assertActorInOrganization(input.actor, org.id);
  const now = input.now ?? new Date();
  const existing = await requireInvite(repository, org.id, input.inviteId);
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
  const deliveryId = randomUUID();

  const updated = await repository.refreshInviteWithDelivery({
    inviteId: existing.id,
    deliveryId,
    expiresAt,
  });
  if (!updated) throw new DashboardAuthError(409, "Invite is no longer pending");

  let sendResult: { providerMessageId: string };
  try {
    sendResult = await input.sendInviteEmail({
      ...template,
      to: existing.email,
      invitationId: existing.id,
      deliveryId,
      acceptUrl,
      expiresAt,
    });
  } catch (error) {
    await deliveries.updateById({
      id: deliveryId,
      status: "failed",
      error: messageFromUnknown(error),
    });
    throw error;
  }

  await recordProviderAcceptedDelivery(deliveries, deliveryId, sendResult.providerMessageId);

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
  return cancelDashboardInviteFromRepository(createAuthRepository(db), input);
}

export function cancelConnectedDashboardInvite(
  input: {
    organizationSlug: string;
    actor: DashboardActor;
    inviteId: string;
    now?: Date;
  },
): Promise<DashboardInviteRow> {
  return cancelDashboardInviteFromRepository(createConnectedAuthRepository(), input);
}

async function cancelDashboardInviteFromRepository(
  repository: AuthRepository,
  input: {
    organizationSlug: string;
    actor: DashboardActor;
    inviteId: string;
    now?: Date;
  },
): Promise<DashboardInviteRow> {
  assertCanManageInvites(input.actor.role);
  const org = await requireOrganization(repository, input.organizationSlug);
  assertActorInOrganization(input.actor, org.id);
  const now = input.now ?? new Date();
  const existing = await requireInvite(repository, org.id, input.inviteId);
  const currentStatus = resolvedInviteStatus(existing.status, existing.expiresAt, now);
  if (currentStatus !== "pending" && currentStatus !== "expired") {
    throw new DashboardAuthError(409, "Invite is not pending");
  }

  const updated = await repository.cancelPendingInvite(existing.id);
  if (!updated) {
    throw new DashboardAuthError(409, "Invite is no longer pending");
  }

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

function assertActorInOrganization(
  actor: DashboardActor,
  organizationId: string,
): void {
  if (actor.organizationId !== organizationId) {
    throw new DashboardAuthError(403, "Forbidden");
  }
}

async function recordProviderAcceptedDelivery(
  deliveries: InviteEmailDeliveryRepository,
  deliveryId: string,
  providerMessageId: string,
): Promise<void> {
  const updated = await deliveries.updateById({
    id: deliveryId,
    resendEmailId: providerMessageId,
    status: "queued",
  });
  if (!updated) {
    throw new DashboardAuthError(500, "Invite email delivery record was not found");
  }
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : "Email provider failed";
}

async function requireOrganization(repository: AuthRepository, slug: string) {
  const org = await repository.findOrganizationBySlug(slug);
  if (!org) throw new DashboardAuthError(404, "Organization not found");
  return org;
}

async function requireInvite(repository: AuthRepository, organizationId: string, inviteId: string) {
  const row = await repository.findOrganizationInvite({ organizationId, inviteId });
  if (!row) throw new DashboardAuthError(404, "Invite not found");
  return row;
}

async function assertCanInviteEmail(
  repository: AuthRepository,
  organizationId: string,
  email: string,
): Promise<void> {
  const existingUser = await repository.findOrganizationMemberByEmail({ organizationId, email });
  if (existingUser) {
    throw new DashboardAuthError(409, "User is already a member");
  }

  const existingInvite = await repository.findPendingOrganizationInviteByEmail({
    organizationId,
    email,
  });
  if (existingInvite) {
    throw new DashboardAuthError(409, "User is already invited");
  }
}

async function latestDeliveryByInvitation(
  repository: AuthRepository,
  invitationIds: string[],
): Promise<Map<string, InviteEmailDeliveryStatus>> {
  if (invitationIds.length === 0) return new Map();
  const rows = await repository.listLatestInviteDeliveryStatuses(invitationIds);

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
