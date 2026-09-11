import { randomUUID } from "node:crypto";
import { and, eq, notInArray } from "drizzle-orm";
import { getDb, type Db } from "../client.js";
import { inviteEmailDelivery } from "../schema.js";

export type InviteEmailDeliveryStatus =
  | "pending_send"
  | "queued"
  | "sent"
  | "bounced"
  | "failed";

export async function createInviteEmailDelivery(
  db: Pick<Db, "insert">,
  input: {
    id?: string;
    invitationId: string;
    resendEmailId?: string | null;
    status?: InviteEmailDeliveryStatus;
    error?: string | null;
  },
) {
  const [row] = await db
    .insert(inviteEmailDelivery)
    .values({
      id: input.id ?? randomUUID(),
      invitationId: input.invitationId,
      resendEmailId: input.resendEmailId ?? null,
      status: input.status ?? (input.resendEmailId ? "queued" : "pending_send"),
      error: input.error ?? null,
    })
    .returning();
  return row;
}

export async function updateInviteEmailDeliveryByResendId(
  db: Db,
  input: { resendEmailId: string; status: InviteEmailDeliveryStatus; error?: string | null },
): Promise<boolean> {
  const byResendId = eq(inviteEmailDelivery.resendEmailId, input.resendEmailId);
  const [row] = await db
    .update(inviteEmailDelivery)
    .set({ status: input.status, error: input.error ?? null, updatedAt: new Date() })
    .where(
      input.status === "sent"
        ? and(byResendId, notInArray(inviteEmailDelivery.status, ["bounced", "failed"]))
        : byResendId,
    )
    .returning({ id: inviteEmailDelivery.id });
  return Boolean(row);
}

export async function updateInviteEmailDeliveryById(
  db: Pick<Db, "update">,
  input: {
    id: string;
    resendEmailId?: string | null;
    status: InviteEmailDeliveryStatus;
    error?: string | null;
  },
): Promise<boolean> {
  const values: {
    resendEmailId?: string | null;
    status: InviteEmailDeliveryStatus;
    error: string | null;
    updatedAt: Date;
  } = { status: input.status, error: input.error ?? null, updatedAt: new Date() };
  if (input.resendEmailId !== undefined) values.resendEmailId = input.resendEmailId;
  const [row] = await db
    .update(inviteEmailDelivery)
    .set(values)
    .where(eq(inviteEmailDelivery.id, input.id))
    .returning({ id: inviteEmailDelivery.id });
  return Boolean(row);
}

export function createInviteEmailDeliveryRepository(db: Db) {
  return {
    updateById(input: Parameters<typeof updateInviteEmailDeliveryById>[1]) {
      return updateInviteEmailDeliveryById(db, input);
    },
    updateByResendId(input: Parameters<typeof updateInviteEmailDeliveryByResendId>[1]) {
      return updateInviteEmailDeliveryByResendId(db, input);
    },
  };
}

export function createConnectedInviteEmailDeliveryRepository() {
  return createInviteEmailDeliveryRepository(getDb());
}

export function updateConnectedInviteEmailDeliveryById(
  input: Parameters<typeof updateInviteEmailDeliveryById>[1],
): Promise<boolean> {
  return updateInviteEmailDeliveryById(getDb(), input);
}

export function updateConnectedInviteEmailDeliveryByResendId(
  input: Parameters<typeof updateInviteEmailDeliveryByResendId>[1],
): Promise<boolean> {
  return updateInviteEmailDeliveryByResendId(getDb(), input);
}
