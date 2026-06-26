import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/client.js";
import {
  invitation,
  inviteEmailDelivery,
  member,
  organization,
  user,
} from "../../db/schema.js";
import { createTestDb } from "../../db/test-db.js";
import type { DashboardActor } from "./users-read.js";
import {
  cancelDashboardInvite,
  createDashboardInvite,
  listDashboardInvites,
  resendDashboardInvite,
  type SendInviteEmail,
} from "./invites.js";

let db: Db;

const ownerActor: DashboardActor = {
  organizationId: "org_aiw",
  memberId: "member_owner",
  userId: "user_owner",
  role: "owner",
};
const adminActor: DashboardActor = {
  organizationId: "org_aiw",
  memberId: "member_admin",
  userId: "user_admin",
  role: "admin",
};
const memberActor: DashboardActor = {
  organizationId: "org_aiw",
  memberId: "member_member",
  userId: "user_member",
  role: "member",
};

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(organization).values({
    id: "org_aiw",
    name: "AI Workflow",
    slug: "ai-workflow",
  });
  await db.insert(user).values([
    {
      id: "user_owner",
      name: "Owner",
      email: "owner@example.com",
      emailVerified: true,
    },
    {
      id: "user_admin",
      name: "Admin",
      email: "admin@example.com",
      emailVerified: true,
    },
    {
      id: "user_member",
      name: "Member",
      email: "member@example.com",
      emailVerified: true,
    },
  ]);
  await db.insert(member).values([
    {
      id: "member_owner",
      organizationId: "org_aiw",
      userId: "user_owner",
      role: "owner",
    },
    {
      id: "member_admin",
      organizationId: "org_aiw",
      userId: "user_admin",
      role: "admin",
    },
    {
      id: "member_member",
      organizationId: "org_aiw",
      userId: "user_member",
      role: "member",
    },
  ]);
});

function acceptedEmail(id = "email_123"): SendInviteEmail {
  return vi.fn(async () => ({ providerMessageId: id }));
}

async function inviteCount(): Promise<number> {
  return (await db.select().from(invitation)).length;
}

describe("dashboard invites", () => {
  it("creates member-only invites and records queued delivery", async () => {
    const sendInviteEmail = acceptedEmail();

    const result = await createDashboardInvite(db, {
      organizationSlug: "ai-workflow",
      organizationName: "AI Workflow",
      dashboardOrigin: "https://dashboard.example.com",
      actor: adminActor,
      email: "New.User@Example.com",
      sendInviteEmail,
      now: new Date("2026-06-26T12:00:00.000Z"),
    });

    expect(result).toMatchObject({
      email: "new.user@example.com",
      role: "member",
      status: "pending",
      emailStatus: "queued",
    });
    expect(sendInviteEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "new.user@example.com",
        acceptUrl: expect.stringContaining(`/invite/accept?id=${result.id}`),
      }),
    );

    const [delivery] = await db.select().from(inviteEmailDelivery);
    expect(delivery).toMatchObject({
      invitationId: result.id,
      resendEmailId: "email_123",
      status: "queued",
    });
  });

  it("does not create an invite when the email provider rejects synchronously", async () => {
    const sendInviteEmail: SendInviteEmail = vi.fn(async () => {
      throw new Error("bad sender");
    });

    await expect(
      createDashboardInvite(db, {
        organizationSlug: "ai-workflow",
        organizationName: "AI Workflow",
        dashboardOrigin: "https://dashboard.example.com",
        actor: ownerActor,
        email: "new.user@example.com",
        sendInviteEmail,
        now: new Date("2026-06-26T12:00:00.000Z"),
      }),
    ).rejects.toThrow("bad sender");

    await expect(inviteCount()).resolves.toBe(0);
  });

  it("keeps the invite if sent email metadata cannot be updated", async () => {
    await db.insert(invitation).values({
      id: "invite_existing",
      organizationId: "org_aiw",
      email: "existing@example.com",
      role: "member",
      status: "pending",
      expiresAt: new Date("2026-06-27T12:00:00.000Z"),
      inviterId: ownerActor.userId,
    });
    await db.insert(inviteEmailDelivery).values({
      id: "delivery_existing",
      invitationId: "invite_existing",
      resendEmailId: "email_duplicate",
      status: "queued",
    });
    const before = await db.select().from(invitation);
    let deliveryExistedBeforeSend = false;
    let sendRanAfterTransaction = false;
    let transactionActive = false;
    const originalTransaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementation((async (callback, config) => {
      transactionActive = true;
      try {
        return await originalTransaction(callback, config);
      } finally {
        transactionActive = false;
      }
    }) as typeof db.transaction);
    const sendInviteEmail: SendInviteEmail = vi.fn(async ({ invitationId }) => {
      sendRanAfterTransaction = !transactionActive;
      const [deliveryIntent] = await db
        .select({ id: inviteEmailDelivery.id })
        .from(inviteEmailDelivery)
        .where(eq(inviteEmailDelivery.invitationId, invitationId))
        .limit(1);
      deliveryExistedBeforeSend = Boolean(deliveryIntent);
      return { providerMessageId: "email_duplicate" };
    });

    await expect(
      createDashboardInvite(db, {
        organizationSlug: "ai-workflow",
        organizationName: "AI Workflow",
        dashboardOrigin: "https://dashboard.example.com",
        actor: ownerActor,
        email: "new.user@example.com",
        sendInviteEmail,
        now: new Date("2026-06-26T12:00:00.000Z"),
      }),
    ).rejects.toThrow();

    const after = await db.select().from(invitation);
    expect(sendInviteEmail).toHaveBeenCalledTimes(1);
    expect(sendRanAfterTransaction).toBe(true);
    expect(deliveryExistedBeforeSend).toBe(true);
    expect(after).toHaveLength(before.length + 1);
    expect(after).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          email: "new.user@example.com",
          status: "pending",
        }),
      ]),
    );
  });

  it("rejects member invite attempts", async () => {
    await expect(
      createDashboardInvite(db, {
        organizationSlug: "ai-workflow",
        organizationName: "AI Workflow",
        dashboardOrigin: "https://dashboard.example.com",
        actor: memberActor,
        email: "new.user@example.com",
        sendInviteEmail: acceptedEmail(),
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("lists invite delivery status and expiry state", async () => {
    const invite = await createDashboardInvite(db, {
      organizationSlug: "ai-workflow",
      organizationName: "AI Workflow",
      dashboardOrigin: "https://dashboard.example.com",
      actor: ownerActor,
      email: "new.user@example.com",
      sendInviteEmail: acceptedEmail(),
      now: new Date("2026-06-20T12:00:00.000Z"),
    });
    await db
      .update(inviteEmailDelivery)
      .set({ status: "bounced", error: "Mailbox unavailable" })
      .where(eq(inviteEmailDelivery.invitationId, invite.id));

    const rows = await listDashboardInvites(db, {
      organizationSlug: "ai-workflow",
      actorRole: "owner",
      now: new Date("2026-06-27T12:00:00.000Z"),
    });

    expect(rows).toEqual([
      expect.objectContaining({
        id: invite.id,
        email: "new.user@example.com",
        invitedBy: "Owner",
        status: "expired",
        emailStatus: "bounced",
        actions: { canResend: true, canCancel: true },
      }),
    ]);
  });

  it("lets admins resend and cancel pending invites", async () => {
    const invite = await createDashboardInvite(db, {
      organizationSlug: "ai-workflow",
      organizationName: "AI Workflow",
      dashboardOrigin: "https://dashboard.example.com",
      actor: ownerActor,
      email: "new.user@example.com",
      sendInviteEmail: acceptedEmail("email_first"),
      now: new Date("2026-06-26T12:00:00.000Z"),
    });

    await expect(
      resendDashboardInvite(db, {
        organizationSlug: "ai-workflow",
        organizationName: "AI Workflow",
        dashboardOrigin: "https://dashboard.example.com",
        actor: adminActor,
        inviteId: invite.id,
        sendInviteEmail: acceptedEmail("email_second"),
        now: new Date("2026-06-26T13:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ emailStatus: "queued" });

    const deliveries = await db.select().from(inviteEmailDelivery);
    expect(deliveries.map((row) => row.resendEmailId).sort()).toEqual([
      "email_first",
      "email_second",
    ]);

    await expect(
      cancelDashboardInvite(db, {
        organizationSlug: "ai-workflow",
        actor: adminActor,
        inviteId: invite.id,
        now: new Date("2026-06-27T12:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ status: "canceled" });
  });

  it("lets admins cancel expired pending invites", async () => {
    const invite = await createDashboardInvite(db, {
      organizationSlug: "ai-workflow",
      organizationName: "AI Workflow",
      dashboardOrigin: "https://dashboard.example.com",
      actor: ownerActor,
      email: "new.user@example.com",
      sendInviteEmail: acceptedEmail(),
      now: new Date("2026-06-20T12:00:00.000Z"),
    });

    await expect(
      cancelDashboardInvite(db, {
        organizationSlug: "ai-workflow",
        actor: adminActor,
        inviteId: invite.id,
        now: new Date("2026-06-27T12:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ status: "canceled" });
  });
});
