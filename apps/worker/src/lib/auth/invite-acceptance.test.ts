import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import {
  createAuth,
  DASHBOARD_SSO_PROVIDER_ID,
  seedAuthUser,
} from "../../auth.js";
import type { Db } from "../../db/client.js";
import { account, invitation, member, organization, user } from "../../db/schema.js";
import { createTestDb } from "../../db/test-db.js";
import type { DashboardRole } from "./roles.js";
import {
  acceptDashboardSsoInvite,
  acceptDashboardInvite,
  getDashboardInviteAcceptanceState,
} from "./invite-acceptance.js";

const OPTS = {
  secret: "x".repeat(32),
  baseURL: "http://localhost:3000",
  trustedOrigins: ["http://localhost:3001"],
};

async function setupInvite(email = "new.user@example.com", role: DashboardRole = "member") {
  const db = await createTestDb();
  const auth = createAuth(db, OPTS);

  await db.insert(organization).values({
    id: "org_aiw",
    name: "AI Workflow",
    slug: "ai-workflow",
  });
  await db.insert(user).values({
    id: "user_owner",
    name: "Owner",
    email: "owner@example.com",
    emailVerified: true,
  });
  await db.insert(invitation).values({
    id: "invite_1",
    organizationId: "org_aiw",
    email,
    role,
    status: "pending",
    expiresAt: new Date("2026-06-28T00:00:00.000Z"),
    inviterId: "user_owner",
  });

  return { db, auth };
}

describe("acceptDashboardInvite", () => {
  it("describes invite acceptance mode for new, password, and SSO-only users", async () => {
    const { db, auth } = await setupInvite();
    await db.insert(invitation).values([
      {
        id: "invite_existing",
        organizationId: "org_aiw",
        email: "existing@example.com",
        role: "member",
        status: "pending",
        expiresAt: new Date("2026-06-28T00:00:00.000Z"),
        inviterId: "user_owner",
      },
      {
        id: "invite_sso",
        organizationId: "org_aiw",
        email: "sso@example.com",
        role: "member",
        status: "pending",
        expiresAt: new Date("2026-06-28T00:00:00.000Z"),
        inviterId: "user_owner",
      },
    ]);
    await seedAuthUser(auth, {
      email: "existing@example.com",
      password: "password123",
      name: "Existing",
    });
    const ctx = await auth.$context;
    const ssoUser = await ctx.internalAdapter.createUser({
      email: "sso@example.com",
      name: "SSO User",
      emailVerified: true,
    });
    await ctx.internalAdapter.linkAccount({
      userId: ssoUser.id,
      providerId: DASHBOARD_SSO_PROVIDER_ID,
      accountId: "sso-subject",
    });

    const base = {
      organizationSlug: "ai-workflow",
      now: new Date("2026-06-26T00:00:00.000Z"),
    };

    await expect(
      getDashboardInviteAcceptanceState(db, auth, { ...base, inviteId: "invite_1" }),
    ).resolves.toMatchObject({
      mode: "new_user",
      organizationName: "AI Workflow",
      role: "member",
    });
    await expect(
      getDashboardInviteAcceptanceState(db, auth, {
        ...base,
        inviteId: "invite_existing",
      }),
    ).resolves.toMatchObject({ mode: "existing_password" });
    await expect(
      getDashboardInviteAcceptanceState(db, auth, { ...base, inviteId: "invite_sso" }),
    ).resolves.toMatchObject({ mode: "sso_only" });
  });

  it("creates a password user, accepts the invite, creates membership, and returns a session token", async () => {
    const { db, auth } = await setupInvite();

    const result = await acceptDashboardInvite(db, auth, {
      organizationSlug: "ai-workflow",
      inviteId: "invite_1",
      name: "New User",
      password: "password123",
      now: new Date("2026-06-26T00:00:00.000Z"),
    });

    expect(result.token).toBeTruthy();
    expect(result.user).toMatchObject({
      email: "new.user@example.com",
      name: "New User",
    });

    const [accepted] = await db
      .select()
      .from(invitation)
      .where(eq(invitation.id, "invite_1"));
    expect(accepted.status).toBe("accepted");

    const [joined] = await db
      .select()
      .from(member)
      .where(
        and(
          eq(member.organizationId, "org_aiw"),
          eq(member.userId, result.user.id),
        ),
      );
    expect(joined).toMatchObject({ role: "member" });

    const session = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${result.token}` }),
    });
    expect(session?.user.email).toBe("new.user@example.com");
  });

  it("preserves admin invite role in preview and accepted membership", async () => {
    const { db, auth } = await setupInvite("new.admin@example.com", "admin");
    const now = new Date("2026-06-26T00:00:00.000Z");

    await expect(
      getDashboardInviteAcceptanceState(db, auth, {
        organizationSlug: "ai-workflow",
        inviteId: "invite_1",
        now,
      }),
    ).resolves.toMatchObject({ role: "admin" });

    const result = await acceptDashboardInvite(db, auth, {
      organizationSlug: "ai-workflow",
      inviteId: "invite_1",
      name: "New Admin",
      password: "password123",
      now,
    });

    const [joined] = await db
      .select()
      .from(member)
      .where(
        and(
          eq(member.organizationId, "org_aiw"),
          eq(member.userId, result.user.id),
        ),
      );
    expect(joined).toMatchObject({ role: "admin" });
  });

  it("lets an existing password user accept by proving the current password", async () => {
    const { db, auth } = await setupInvite("existing@example.com");
    await seedAuthUser(auth, {
      email: "existing@example.com",
      password: "password123",
      name: "Existing",
    });

    const result = await acceptDashboardInvite(db, auth, {
      organizationSlug: "ai-workflow",
      inviteId: "invite_1",
      password: "password123",
      now: new Date("2026-06-26T00:00:00.000Z"),
    });

    expect(result.user.email).toBe("existing@example.com");
    const members = await db
      .select()
      .from(member)
      .where(eq(member.userId, result.user.id));
    expect(members).toHaveLength(1);
  });

  it("updates an existing member role when accepting a higher-role invite", async () => {
    const { db, auth } = await setupInvite("existing@example.com", "admin");
    await seedAuthUser(auth, {
      email: "existing@example.com",
      password: "password123",
      name: "Existing",
    });
    const [existingUser] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, "existing@example.com"));
    await db.insert(member).values({
      id: "member_existing",
      organizationId: "org_aiw",
      userId: existingUser.id,
      role: "member",
    });

    const result = await acceptDashboardInvite(db, auth, {
      organizationSlug: "ai-workflow",
      inviteId: "invite_1",
      password: "password123",
      now: new Date("2026-06-26T00:00:00.000Z"),
    });

    const [membership] = await db
      .select({ role: member.role })
      .from(member)
      .where(eq(member.userId, result.user.id));
    expect(membership).toEqual({ role: "admin" });
  });

  it("does not demote an existing owner when accepting a lower-role invite", async () => {
    const { db, auth } = await setupInvite("existing@example.com", "member");
    await seedAuthUser(auth, {
      email: "existing@example.com",
      password: "password123",
      name: "Existing",
    });
    const [existingUser] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, "existing@example.com"));
    await db.insert(member).values({
      id: "member_existing",
      organizationId: "org_aiw",
      userId: existingUser.id,
      role: "owner",
    });

    await acceptDashboardInvite(db, auth, {
      organizationSlug: "ai-workflow",
      inviteId: "invite_1",
      password: "password123",
      now: new Date("2026-06-26T00:00:00.000Z"),
    });

    const [membership] = await db
      .select({ role: member.role })
      .from(member)
      .where(eq(member.userId, existingUser.id));
    expect(membership).toEqual({ role: "owner" });
  });

  it("accepts an SSO-only invite for the authenticated SSO user", async () => {
    const { db, auth } = await setupInvite("sso@example.com", "admin");
    const ctx = await auth.$context;
    const ssoUser = await ctx.internalAdapter.createUser({
      email: "sso@example.com",
      name: "SSO User",
      emailVerified: true,
    });
    await ctx.internalAdapter.linkAccount({
      userId: ssoUser.id,
      providerId: DASHBOARD_SSO_PROVIDER_ID,
      accountId: "sso-subject",
    });

    await acceptDashboardSsoInvite(db, auth, {
      organizationSlug: "ai-workflow",
      inviteId: "invite_1",
      user: { id: ssoUser.id, email: "sso@example.com" },
      now: new Date("2026-06-26T00:00:00.000Z"),
    });

    const [accepted] = await db
      .select({ status: invitation.status })
      .from(invitation)
      .where(eq(invitation.id, "invite_1"));
    expect(accepted).toEqual({ status: "accepted" });

    const [membership] = await db
      .select({ role: member.role })
      .from(member)
      .where(eq(member.userId, ssoUser.id));
    expect(membership).toEqual({ role: "admin" });
  });

  it("re-checks pending invite state before creating membership", async () => {
    const { db, auth } = await setupInvite();
    const originalTransaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementation((async (callback, config) => {
      await db
        .update(invitation)
        .set({ status: "accepted" })
        .where(eq(invitation.id, "invite_1"));
      return originalTransaction(callback, config);
    }) as typeof db.transaction);

    await expect(
      acceptDashboardInvite(db, auth, {
        organizationSlug: "ai-workflow",
        inviteId: "invite_1",
        name: "New User",
        password: "password123",
        now: new Date("2026-06-26T00:00:00.000Z"),
      }),
    ).rejects.toThrow("Invite not found");

    await expect(userCount(db, "new.user@example.com")).resolves.toBe(0);
    const memberships = await db.select().from(member);
    expect(memberships).toHaveLength(0);
  });

  it("rejects expired invites without creating a user", async () => {
    const { db, auth } = await setupInvite();

    await expect(
      acceptDashboardInvite(db, auth, {
        organizationSlug: "ai-workflow",
        inviteId: "invite_1",
        password: "password123",
        now: new Date("2026-07-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow("Invite not found");

    await expect(userCount(db, "new.user@example.com")).resolves.toBe(0);
  });

  it("does not let an existing SSO-only user create a password through invite acceptance", async () => {
    const { db, auth } = await setupInvite("sso@example.com");
    const ctx = await auth.$context;
    const ssoUser = await ctx.internalAdapter.createUser({
      email: "sso@example.com",
      name: "SSO User",
      emailVerified: true,
    });
    await ctx.internalAdapter.linkAccount({
      userId: ssoUser.id,
      providerId: DASHBOARD_SSO_PROVIDER_ID,
      accountId: "sso-subject",
    });

    await expect(
      acceptDashboardInvite(db, auth, {
        organizationSlug: "ai-workflow",
        inviteId: "invite_1",
        password: "password123",
        now: new Date("2026-06-26T00:00:00.000Z"),
      }),
    ).rejects.toThrow("Use SSO to sign in");

    const accounts = await db
      .select()
      .from(account)
      .where(
        and(
          eq(account.userId, ssoUser.id),
          eq(account.providerId, "credential"),
        ),
      );
    expect(accounts).toHaveLength(0);
  });
});

async function userCount(db: Db, email: string): Promise<number> {
  return (await db.select().from(user).where(eq(user.email, email))).length;
}
