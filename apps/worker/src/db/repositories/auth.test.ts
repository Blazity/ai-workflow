import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../client.js";
import {
  account,
  invitation,
  inviteEmailDelivery,
  member,
  organization,
  user,
} from "../schema.js";
import { createTestDb } from "../test-db.js";
import { createAuthRepository } from "./auth.js";

const now = new Date("2026-09-11T08:00:00.000Z");
const expiresAt = new Date("2026-09-13T08:00:00.000Z");
let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(organization).values({ id: "org", name: "Org", slug: "org" });
  await db.insert(user).values({
    id: "owner",
    name: "Owner",
    email: "owner@example.com",
    emailVerified: true,
  });
});

async function seedInvite(id: string, email = `${id}@example.com`) {
  await db.insert(invitation).values({
    id,
    organizationId: "org",
    email,
    role: "member",
    status: "pending",
    expiresAt,
    inviterId: "owner",
  });
}

describe("auth repository atomic writes", () => {
  it("creates an invite and delivery together", async () => {
    const row = await createAuthRepository(db).createInviteWithDelivery({
      inviteId: "invite-create",
      deliveryId: "delivery-create",
      organizationId: "org",
      email: "new@example.com",
      expiresAt,
      inviterId: "owner",
    });
    expect(row.id).toBe("invite-create");
    expect(await db.select().from(inviteEmailDelivery)).toHaveLength(1);
  });

  it("rolls back invite creation when its delivery insert fails", async () => {
    await seedInvite("seed");
    await db.insert(inviteEmailDelivery).values({
      id: "duplicate-delivery",
      invitationId: "seed",
      status: "pending_send",
    });
    await expect(createAuthRepository(db).createInviteWithDelivery({
      inviteId: "rolled-back",
      deliveryId: "duplicate-delivery",
      organizationId: "org",
      email: "rollback@example.com",
      expiresAt,
      inviterId: "owner",
    })).rejects.toThrow();
    expect(await db.select().from(invitation).where(eq(invitation.id, "rolled-back")))
      .toHaveLength(0);
  });

  it("refreshes an invite and records another delivery", async () => {
    await seedInvite("refresh");
    const nextExpiry = new Date("2026-09-14T08:00:00.000Z");
    const row = await createAuthRepository(db).refreshInviteWithDelivery({
      inviteId: "refresh",
      deliveryId: "delivery-refresh",
      expiresAt: nextExpiry,
    });
    expect(row?.expiresAt).toEqual(nextExpiry);
    expect(await db.select().from(inviteEmailDelivery)).toHaveLength(1);
  });

  it("rolls back an invite refresh when its delivery insert fails", async () => {
    await seedInvite("refresh-rollback");
    await seedInvite("delivery-owner");
    await db.insert(inviteEmailDelivery).values({
      id: "duplicate-refresh",
      invitationId: "delivery-owner",
      status: "pending_send",
    });
    await expect(createAuthRepository(db).refreshInviteWithDelivery({
      inviteId: "refresh-rollback",
      deliveryId: "duplicate-refresh",
      expiresAt: new Date("2026-09-20T08:00:00.000Z"),
    })).rejects.toThrow();
    const [row] = await db.select().from(invitation)
      .where(eq(invitation.id, "refresh-rollback"));
    expect(row?.expiresAt).toEqual(expiresAt);
  });

  it("accepts a password invite with user, credential, and membership", async () => {
    await seedInvite("password", "password@example.com");
    const accepted = await createAuthRepository(db).acceptPasswordInvite({
      organizationId: "org",
      inviteId: "password",
      now,
      userId: "password-user",
      userEmail: "password@example.com",
      userName: "Password User",
      newPasswordHash: "hash:scrypt:test",
      accountId: "password-account",
      membershipId: "password-member",
    });
    expect(accepted).toBe(true);
    expect(await db.select().from(account).where(eq(account.id, "password-account")))
      .toHaveLength(1);
    expect(await db.select().from(member).where(eq(member.id, "password-member")))
      .toHaveLength(1);
  });

  it("rolls back password acceptance when credential creation fails", async () => {
    await seedInvite("password-rollback", "rollback-password@example.com");
    await expect(createAuthRepository(db).acceptPasswordInvite({
      organizationId: "org",
      inviteId: "password-rollback",
      now,
      userId: "rolled-back-user",
      userEmail: "rollback-password@example.com",
      userName: "Rolled Back",
      newPasswordHash: "hash:scrypt:test",
      accountId: null,
      membershipId: "rolled-back-member",
    })).rejects.toThrow();
    expect(await db.select().from(user).where(eq(user.id, "rolled-back-user")))
      .toHaveLength(0);
    const [invite] = await db.select().from(invitation)
      .where(eq(invitation.id, "password-rollback"));
    expect(invite?.status).toBe("pending");
  });

  it("accepts an SSO invite with its membership", async () => {
    await seedInvite("sso", "sso@example.com");
    await db.insert(user).values({
      id: "sso-user",
      name: "SSO User",
      email: "sso@example.com",
      emailVerified: true,
    });
    expect(await createAuthRepository(db).acceptSsoInvite({
      organizationId: "org",
      inviteId: "sso",
      now,
      userId: "sso-user",
      membershipId: "sso-member",
    })).toBe(true);
    expect(await db.select().from(member).where(eq(member.id, "sso-member")))
      .toHaveLength(1);
  });

  it("rolls back SSO acceptance when membership creation fails", async () => {
    await seedInvite("sso-rollback", "sso-rollback@example.com");
    await expect(createAuthRepository(db).acceptSsoInvite({
      organizationId: "org",
      inviteId: "sso-rollback",
      now,
      userId: "missing-user",
      membershipId: "invalid-member",
    })).rejects.toThrow();
    const [invite] = await db.select().from(invitation)
      .where(eq(invitation.id, "sso-rollback"));
    expect(invite?.status).toBe("pending");
  });
});
