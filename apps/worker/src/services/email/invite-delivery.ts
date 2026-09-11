import type { Db } from "../../db/types.js";
import {
  createInviteEmailDelivery as createDelivery,
  updateInviteEmailDeliveryById as updateDeliveryById,
  updateInviteEmailDeliveryByResendId as updateDeliveryByResendId,
  type InviteEmailDeliveryStatus,
} from "../../db/repositories/invite-email-deliveries.js";

export type { InviteEmailDeliveryStatus } from "../../db/repositories/invite-email-deliveries.js";

type InviteEmailDeliveryDb = Pick<Db, "insert" | "update">;

export interface CreateInviteEmailDeliveryInput {
  id?: string;
  invitationId: string;
  resendEmailId?: string | null;
  status?: InviteEmailDeliveryStatus;
  error?: string | null;
}

export interface UpdateInviteEmailDeliveryInput {
  resendEmailId: string;
  status: InviteEmailDeliveryStatus;
  error?: string | null;
}

export interface UpdateInviteEmailDeliveryByIdInput {
  id: string;
  resendEmailId?: string | null;
  status: InviteEmailDeliveryStatus;
  error?: string | null;
}

export interface ResendEmailDeliveryEvent {
  type?: string;
  data?: {
    email_id?: string;
    tags?: Record<string, string | undefined>;
    bounce?: {
      message?: string;
      type?: string;
      subType?: string;
    };
    failed?: {
      reason?: string;
    };
    suppressed?: {
      message?: string;
      type?: string;
    };
  };
}

type MappedResendDeliveryEvent = {
  deliveryId?: string;
  resendEmailId?: string;
  status: InviteEmailDeliveryStatus;
  error?: string | null;
};

export async function createInviteEmailDelivery(
  db: InviteEmailDeliveryDb,
  input: CreateInviteEmailDeliveryInput,
) {
  return createDelivery(db, input);
}

export async function updateInviteEmailDeliveryByResendId(
  db: Db,
  input: UpdateInviteEmailDeliveryInput,
): Promise<boolean> {
  return updateDeliveryByResendId(db, input);
}

export async function updateInviteEmailDeliveryById(
  db: InviteEmailDeliveryDb,
  input: UpdateInviteEmailDeliveryByIdInput,
): Promise<boolean> {
  return updateDeliveryById(db, input);
}

export async function applyInviteEmailDeliveryEvent(
  db: Db,
  event: ResendEmailDeliveryEvent,
): Promise<{ handled: boolean; updated: boolean }> {
  const update = mapResendDeliveryEvent(event);
  if (!update) {
    return { handled: false, updated: false };
  }

  if (update.deliveryId) {
    const updatedById = await updateInviteEmailDeliveryById(db, {
      id: update.deliveryId,
      resendEmailId: update.resendEmailId,
      status: update.status,
      error: update.error,
    });
    if (updatedById) {
      return { handled: true, updated: true };
    }
  }

  const updated = update.resendEmailId
    ? await updateInviteEmailDeliveryByResendId(db, {
        resendEmailId: update.resendEmailId,
        status: update.status,
        error: update.error,
      })
    : false;
  return { handled: true, updated };
}

function mapResendDeliveryEvent(
  event: ResendEmailDeliveryEvent,
): MappedResendDeliveryEvent | null {
  const resendEmailId = event.data?.email_id;
  const deliveryId = event.data?.tags?.invite_delivery_id?.trim() || undefined;
  if (!resendEmailId && !deliveryId) return null;

  switch (event.type) {
    case "email.sent":
    case "email.delivered":
      return { deliveryId, resendEmailId, status: "sent", error: null };
    case "email.bounced":
      return {
        deliveryId,
        resendEmailId,
        status: "bounced",
        error: event.data?.bounce?.message ?? "Email bounced",
      };
    case "email.complained":
      return {
        deliveryId,
        resendEmailId,
        status: "failed",
        error: "Recipient complained",
      };
    case "email.failed":
      return {
        deliveryId,
        resendEmailId,
        status: "failed",
        error: event.data?.failed?.reason ?? "Email failed",
      };
    case "email.suppressed":
      return {
        deliveryId,
        resendEmailId,
        status: "failed",
        error: event.data?.suppressed?.message ?? "Email suppressed",
      };
    default:
      return null;
  }
}
