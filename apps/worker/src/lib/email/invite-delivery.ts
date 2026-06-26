import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { inviteEmailDelivery } from "../../db/schema.js";

export type InviteEmailDeliveryStatus = "queued" | "sent" | "bounced" | "failed";

export interface CreateInviteEmailDeliveryInput {
  id?: string;
  invitationId: string;
  resendEmailId: string;
  status?: InviteEmailDeliveryStatus;
  error?: string | null;
}

export interface UpdateInviteEmailDeliveryInput {
  resendEmailId: string;
  status: InviteEmailDeliveryStatus;
  error?: string | null;
}

export interface ResendEmailDeliveryEvent {
  type?: string;
  data?: {
    email_id?: string;
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

export async function createInviteEmailDelivery(
  db: Db,
  input: CreateInviteEmailDeliveryInput,
) {
  const [row] = await db
    .insert(inviteEmailDelivery)
    .values({
      id: input.id ?? randomUUID(),
      invitationId: input.invitationId,
      resendEmailId: input.resendEmailId,
      status: input.status ?? "queued",
      error: input.error ?? null,
    })
    .returning();

  return row;
}

export async function updateInviteEmailDeliveryByResendId(
  db: Db,
  input: UpdateInviteEmailDeliveryInput,
): Promise<boolean> {
  const [row] = await db
    .update(inviteEmailDelivery)
    .set({
      status: input.status,
      error: input.error ?? null,
      updatedAt: new Date(),
    })
    .where(eq(inviteEmailDelivery.resendEmailId, input.resendEmailId))
    .returning({ id: inviteEmailDelivery.id });

  return !!row;
}

export async function applyInviteEmailDeliveryEvent(
  db: Db,
  event: ResendEmailDeliveryEvent,
): Promise<{ handled: boolean; updated: boolean }> {
  const update = mapResendDeliveryEvent(event);
  if (!update) {
    return { handled: false, updated: false };
  }

  const updated = await updateInviteEmailDeliveryByResendId(db, update);
  return { handled: true, updated };
}

function mapResendDeliveryEvent(
  event: ResendEmailDeliveryEvent,
): UpdateInviteEmailDeliveryInput | null {
  const resendEmailId = event.data?.email_id;
  if (!resendEmailId) return null;

  switch (event.type) {
    case "email.sent":
    case "email.delivered":
      return { resendEmailId, status: "sent", error: null };
    case "email.bounced":
      return {
        resendEmailId,
        status: "bounced",
        error: event.data?.bounce?.message ?? "Email bounced",
      };
    case "email.complained":
      return {
        resendEmailId,
        status: "failed",
        error: "Recipient complained",
      };
    case "email.failed":
      return {
        resendEmailId,
        status: "failed",
        error: event.data?.failed?.reason ?? "Email failed",
      };
    case "email.suppressed":
      return {
        resendEmailId,
        status: "failed",
        error: event.data?.suppressed?.message ?? "Email suppressed",
      };
    default:
      return null;
  }
}
