/* oxlint-disable eslint/max-lines */
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
    expect(await db.select().from(user).where(eq(user.id, "password-user")))
      .toHaveLength(1);
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

  it("rolls back password acceptance when membership creation fails", async () => {
    await seedInvite("membership-rollback", "membership-rollback@example.com");
    await db.insert(member).values({
      id: "duplicate-member",
      organizationId: "org",
      userId: "owner",
      role: "owner",
    });

    await expect(createAuthRepository(db).acceptPasswordInvite({
      organizationId: "org",
      inviteId: "membership-rollback",
      now,
      userId: "membership-rollback-user",
      userEmail: "membership-rollback@example.com",
      userName: "Membership Rollback",
      newPasswordHash: "hash:scrypt:test",
      accountId: "membership-rollback-account",
      membershipId: "duplicate-member",
    })).rejects.toThrow();

    expect(await db.select().from(user).where(eq(user.id, "membership-rollback-user")))
      .toHaveLength(0);
    expect(await db.select().from(account).where(eq(account.id, "membership-rollback-account")))
      .toHaveLength(0);
    const [invite] = await db.select().from(invitation)
      .where(eq(invitation.id, "membership-rollback"));
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
      userEmail: "sso@example.com",
      membershipId: "sso-member",
    })).toBe(true);
    expect(await db.select().from(member).where(eq(member.id, "sso-member")))
      .toHaveLength(1);
  });

  it("matches an SSO invite email after trimming tabs as well as spaces", async () => {
    await seedInvite("sso-tab", "\tsso-tab@example.com\t");
    await db.insert(user).values({
      id: "sso-tab-user",
      name: "SSO Tab User",
      email: "sso-tab@example.com",
      emailVerified: true,
    });

    await expect(createAuthRepository(db).acceptSsoInvite({
      organizationId: "org",
      inviteId: "sso-tab",
      now,
      userId: "sso-tab-user",
      userEmail: "sso-tab@example.com",
      membershipId: "sso-tab-member",
    })).resolves.toBe(true);
  });

  it("rejects an SSO invite when the locked email does not match", async () => {
    await seedInvite("sso-mismatch", "invited@example.com");
    await db.insert(user).values({
      id: "other-sso-user",
      name: "Other SSO User",
      email: "other@example.com",
      emailVerified: true,
    });

    await expect(createAuthRepository(db).acceptSsoInvite({
      organizationId: "org",
      inviteId: "sso-mismatch",
      now,
      userId: "other-sso-user",
      userEmail: "other@example.com",
      membershipId: "sso-mismatch-member",
    })).resolves.toBe(false);

    expect(await db.select().from(member).where(eq(member.id, "sso-mismatch-member")))
      .toHaveLength(0);
    const [invite] = await db.select().from(invitation)
      .where(eq(invitation.id, "sso-mismatch"));
    expect(invite?.status).toBe("pending");
  });

  it("rolls back SSO acceptance when membership creation fails", async () => {
    await seedInvite("sso-rollback", "sso-rollback@example.com");
    await expect(createAuthRepository(db).acceptSsoInvite({
      organizationId: "org",
      inviteId: "sso-rollback",
      now,
      userId: "missing-user",
      userEmail: "sso-rollback@example.com",
      membershipId: "invalid-member",
    })).rejects.toThrow();
    const [invite] = await db.select().from(invitation)
      .where(eq(invitation.id, "sso-rollback"));
    expect(invite?.status).toBe("pending");
  });

  it("returns false on a second acceptance and leaves membership byte-identical", async () => {
    await seedInvite("sso-repeat", "sso-repeat@example.com");
    await db.insert(user).values({
      id: "sso-repeat-user",
      name: "SSO Repeat User",
      email: "sso-repeat@example.com",
      emailVerified: true,
    });
    const repository = createAuthRepository(db);
    const first = {
      organizationId: "org",
      inviteId: "sso-repeat",
      now,
      userId: "sso-repeat-user",
      userEmail: "sso-repeat@example.com",
      membershipId: "sso-repeat-member",
    };
    await expect(repository.acceptSsoInvite(first)).resolves.toBe(true);
    const [before] = await db.select().from(member)
      .where(eq(member.id, "sso-repeat-member"));

    await expect(repository.acceptSsoInvite({
      ...first,
      membershipId: "unused-repeat-member",
    })).resolves.toBe(false);

    const [after] = await db.select().from(member)
      .where(eq(member.id, "sso-repeat-member"));
    expect(after).toEqual(before);
    expect(await db.select().from(member).where(eq(member.id, "unused-repeat-member")))
      .toHaveLength(0);
  });

  it("returns false for a canceled invite without creating acceptance rows", async () => {
    await seedInvite("canceled", "canceled@example.com");
    await db.update(invitation).set({ status: "canceled" })
      .where(eq(invitation.id, "canceled"));

    await expect(createAuthRepository(db).acceptPasswordInvite({
      organizationId: "org",
      inviteId: "canceled",
      now,
      userId: "canceled-user",
      userEmail: "canceled@example.com",
      userName: "Canceled User",
      newPasswordHash: "hash:scrypt:test",
      accountId: "canceled-account",
      membershipId: "canceled-member",
    })).resolves.toBe(false);

    expect(await db.select().from(user).where(eq(user.id, "canceled-user")))
      .toHaveLength(0);
    expect(await db.select().from(account).where(eq(account.id, "canceled-account")))
      .toHaveLength(0);
    expect(await db.select().from(member).where(eq(member.id, "canceled-member")))
      .toHaveLength(0);
  });

  it("does not demote an owner who accepts an admin invite", async () => {
    await seedInvite("owner-admin", "owner-admin@example.com");
    await db.update(invitation).set({ role: "admin" })
      .where(eq(invitation.id, "owner-admin"));
    await db.insert(user).values({
      id: "owner-admin-user",
      name: "Existing Owner",
      email: "owner-admin@example.com",
      emailVerified: true,
    });
    await db.insert(member).values({
      id: "owner-admin-member",
      organizationId: "org",
      userId: "owner-admin-user",
      role: "owner",
    });

    await expect(createAuthRepository(db).acceptPasswordInvite({
      organizationId: "org",
      inviteId: "owner-admin",
      now,
      userId: "owner-admin-user",
      userEmail: "owner-admin@example.com",
      userName: "Existing Owner",
      newPasswordHash: null,
      accountId: null,
      membershipId: "unused-owner-admin-member",
    })).resolves.toBe(true);

    const [membership] = await db.select({ role: member.role }).from(member)
      .where(eq(member.id, "owner-admin-member"));
    expect(membership).toEqual({ role: "owner" });
  });
});
