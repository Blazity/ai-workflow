import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../db/client.js";
import {
  invitation,
  inviteEmailDelivery,
  organization,
  user,
} from "../../db/schema.js";
import { createTestDb } from "../../db/test-db.js";
import {
  applyInviteEmailDeliveryEvent,
  createInviteEmailDelivery,
  updateInviteEmailDeliveryByResendId,
} from "./invite-delivery.js";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(user).values({
    id: "user_owner",
    name: "Owner",
    email: "owner@example.com",
    emailVerified: true,
  });
  await db.insert(organization).values({
    id: "org_acme",
    name: "Acme",
    slug: "acme",
  });
  await db.insert(invitation).values({
    id: "invite_acme",
    organizationId: "org_acme",
    email: "new.user@example.com",
    role: "member",
    status: "pending",
    expiresAt: new Date("2026-07-01T00:00:00.000Z"),
    inviterId: "user_owner",
  });
});

async function findDelivery(resendEmailId: string) {
  const [row] = await db
    .select({
      invitationId: inviteEmailDelivery.invitationId,
      resendEmailId: inviteEmailDelivery.resendEmailId,
      status: inviteEmailDelivery.status,
      error: inviteEmailDelivery.error,
    })
    .from(inviteEmailDelivery)
    .where(eq(inviteEmailDelivery.resendEmailId, resendEmailId));
  return row;
}

async function findDeliveryById(id: string) {
  const [row] = await db
    .select({
      invitationId: inviteEmailDelivery.invitationId,
      resendEmailId: inviteEmailDelivery.resendEmailId,
      status: inviteEmailDelivery.status,
      error: inviteEmailDelivery.error,
    })
    .from(inviteEmailDelivery)
    .where(eq(inviteEmailDelivery.id, id));
  return row;
}

describe("invite delivery helpers", () => {
  it("creates a pending delivery intent before a provider id exists", async () => {
    await createInviteEmailDelivery(db, {
      id: "delivery_pending",
      invitationId: "invite_acme",
      status: "pending_send",
    });

    await expect(findDeliveryById("delivery_pending")).resolves.toEqual({
      invitationId: "invite_acme",
      resendEmailId: null,
      status: "pending_send",
      error: null,
    });
  });

  it("creates an invite delivery row for an accepted send", async () => {
    await createInviteEmailDelivery(db, {
      id: "delivery_acme",
      invitationId: "invite_acme",
      resendEmailId: "email_123",
    });

    await expect(findDelivery("email_123")).resolves.toEqual({
      invitationId: "invite_acme",
      resendEmailId: "email_123",
      status: "queued",
      error: null,
    });
  });

  it("updates a delivery row by Resend email id", async () => {
    await createInviteEmailDelivery(db, {
      id: "delivery_acme",
      invitationId: "invite_acme",
      resendEmailId: "email_123",
    });

    await expect(
      updateInviteEmailDeliveryByResendId(db, {
        resendEmailId: "email_123",
        status: "failed",
        error: "Provider rejected the message",
      }),
    ).resolves.toBe(true);

    await expect(findDelivery("email_123")).resolves.toMatchObject({
      status: "failed",
      error: "Provider rejected the message",
    });
  });

  it("accepts unknown Resend email ids without throwing", async () => {
    await expect(
      updateInviteEmailDeliveryByResendId(db, {
        resendEmailId: "missing",
        status: "failed",
        error: "No row",
      }),
    ).resolves.toBe(false);
  });

  it("maps bounced events to bounced status with the provider reason", async () => {
    await createInviteEmailDelivery(db, {
      id: "delivery_acme",
      invitationId: "invite_acme",
      resendEmailId: "email_123",
    });

    await expect(
      applyInviteEmailDeliveryEvent(db, {
        type: "email.bounced",
        data: {
          email_id: "email_123",
          bounce: {
            message: "Mailbox unavailable",
            type: "hard_bounce",
            subType: "general",
          },
        },
      }),
    ).resolves.toEqual({ handled: true, updated: true });

    await expect(findDelivery("email_123")).resolves.toMatchObject({
      status: "bounced",
      error: "Mailbox unavailable",
    });
  });

  it("maps hard failure-like events to failed status", async () => {
    await createInviteEmailDelivery(db, {
      id: "delivery_acme",
      invitationId: "invite_acme",
      resendEmailId: "email_123",
    });

    await expect(
      applyInviteEmailDeliveryEvent(db, {
        type: "email.failed",
        data: {
          email_id: "email_123",
          failed: { reason: "Sending quota exceeded" },
        },
      }),
    ).resolves.toEqual({ handled: true, updated: true });

    await expect(findDelivery("email_123")).resolves.toMatchObject({
      status: "failed",
      error: "Sending quota exceeded",
    });
  });

  it("does not overwrite terminal failures with later delivered events", async () => {
    await createInviteEmailDelivery(db, {
      id: "delivery_acme",
      invitationId: "invite_acme",
      resendEmailId: "email_123",
      status: "failed",
      error: "Previous temporary failure",
    });

    await expect(
      applyInviteEmailDeliveryEvent(db, {
        type: "email.delivered",
        data: { email_id: "email_123" },
      }),
    ).resolves.toEqual({ handled: true, updated: false });

    await expect(findDelivery("email_123")).resolves.toMatchObject({
      status: "failed",
      error: "Previous temporary failure",
    });
  });
});
