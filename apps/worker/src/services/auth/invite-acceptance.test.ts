import { and, eq, sql } from "drizzle-orm";
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

  it("keeps preview refusal distinctions and the SSO email mismatch", async () => {
    const { db, auth } = await setupInvite();
    const input = {
      organizationSlug: "ai-workflow",
      inviteId: "invite_1",
      now: new Date("2026-06-26T00:00:00.000Z"),
    };

    await db.update(invitation).set({ status: "accepted" })
      .where(eq(invitation.id, "invite_1"));
    await expect(getDashboardInviteAcceptanceState(db, auth, input))
      .rejects.toMatchObject({ statusCode: 409, message: "Invite already accepted" });
    await expect(acceptDashboardSsoInvite(db, auth, {
      ...input,
      user: { id: "other", email: "other@example.com" },
    })).rejects.toMatchObject({
      statusCode: 403,
      message: "Invite does not match signed-in user",
    });

    await db.update(invitation).set({ status: "pending", expiresAt: new Date("2026-06-25T00:00:00.000Z") })
      .where(eq(invitation.id, "invite_1"));
    await expect(getDashboardInviteAcceptanceState(db, auth, input))
      .rejects.toMatchObject({ statusCode: 410, message: "Invite expired" });

    await db.delete(invitation).where(eq(invitation.id, "invite_1"));
    await expect(getDashboardInviteAcceptanceState(db, auth, input))
      .rejects.toMatchObject({ statusCode: 404, message: "Invite not found" });

    await db.insert(invitation).values({
      id: "invite_1",
      organizationId: "org_aiw",
      email: "new.user@example.com",
      role: "member",
      status: "pending",
      expiresAt: new Date("2026-06-28T00:00:00.000Z"),
      inviterId: "user_owner",
    });
    await expect(acceptDashboardSsoInvite(db, auth, {
      ...input,
      user: { id: "other", email: "other@example.com" },
    })).rejects.toMatchObject({
      statusCode: 403,
      message: "Invite does not match signed-in user",
    });
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

  it("treats an accepted invite as success only for its existing member", async () => {
    const { db, auth } = await setupInvite("sso@example.com", "admin");
    await db.update(invitation).set({ status: "accepted" })
      .where(eq(invitation.id, "invite_1"));
    await db.insert(user).values({
      id: "user_sso",
      name: "SSO User",
      email: "sso@example.com",
      emailVerified: true,
    });
    await db.insert(member).values({
      id: "member_sso",
      organizationId: "org_aiw",
      userId: "user_sso",
      role: "admin",
    });

    await expect(acceptDashboardSsoInvite(db, auth, {
      organizationSlug: "ai-workflow",
      inviteId: "invite_1",
      user: { id: "user_sso", email: "sso@example.com" },
      now: new Date("2026-06-26T00:00:00.000Z"),
    })).resolves.toBeUndefined();

    await expect(acceptDashboardSsoInvite(db, auth, {
      organizationSlug: "ai-workflow",
      inviteId: "invite_1",
      user: { id: "user_other", email: "sso@example.com" },
      now: new Date("2026-06-26T00:00:00.000Z"),
    })).rejects.toMatchObject({ statusCode: 409, message: "Invite already accepted" });
  });

  it("re-checks pending invite state before creating membership", async () => {
    const { db, auth } = await setupInvite();
    const originalExecute = db.execute.bind(db);
    const executeSpy = vi.spyOn(db, "execute").mockImplementation((async (query) => {
      await db
        .update(invitation)
        .set({ status: "accepted" })
        .where(eq(invitation.id, "invite_1"));
      return originalExecute(query);
    }) as typeof db.execute);

    try {
      await expect(
        acceptDashboardInvite(db, auth, {
          organizationSlug: "ai-workflow",
          inviteId: "invite_1",
          name: "New User",
          password: "password123",
          now: new Date("2026-06-26T00:00:00.000Z"),
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: "Invite already accepted",
      });
    } finally {
      executeSpy.mockRestore();
    }

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
    ).rejects.toMatchObject({ statusCode: 410, message: "Invite expired" });

    await expect(userCount(db, "new.user@example.com")).resolves.toBe(0);
  });

  it("reports a revoked invite without creating a user", async () => {
    const { db, auth } = await setupInvite();
    await db.update(invitation).set({ status: "canceled" })
      .where(eq(invitation.id, "invite_1"));

    await expect(
      acceptDashboardInvite(db, auth, {
        organizationSlug: "ai-workflow",
        inviteId: "invite_1",
        password: "password123",
        now: new Date("2026-06-26T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ statusCode: 409, message: "Invite was revoked" });

    await expect(userCount(db, "new.user@example.com")).resolves.toBe(0);
  });

  it("reports an absent invite", async () => {
    const { db, auth } = await setupInvite();
    await db.delete(invitation).where(eq(invitation.id, "invite_1"));

    await expect(
      acceptDashboardInvite(db, auth, {
        organizationSlug: "ai-workflow",
        inviteId: "invite_1",
        password: "password123",
        now: new Date("2026-06-26T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ statusCode: 404, message: "Invite not found" });
  });

  it("reports an invalid invite role", async () => {
    const { db, auth } = await setupInvite();
    await db.execute(sql`alter table invitation drop constraint invitation_role_check`);
    try {
      await db.update(invitation).set({ role: "invalid" })
        .where(eq(invitation.id, "invite_1"));

      await expect(
        acceptDashboardInvite(db, auth, {
          organizationSlug: "ai-workflow",
          inviteId: "invite_1",
          password: "password123",
          now: new Date("2026-06-26T00:00:00.000Z"),
        }),
      ).rejects.toMatchObject({ statusCode: 500, message: "Invalid invite role" });
    } finally {
      await db.update(invitation).set({ role: "member" })
        .where(eq(invitation.id, "invite_1"));
      await db.execute(sql`
        alter table invitation add constraint invitation_role_check
        check (role in ('owner', 'admin', 'member'))
      `);
    }
  });

  it("re-checks the invited email inside SSO acceptance SQL", async () => {
    const { db, auth } = await setupInvite("sso-race@example.com");
    const ctx = await auth.$context;
    const ssoUser = await ctx.internalAdapter.createUser({
      email: "sso-race@example.com",
      name: "SSO Race User",
      emailVerified: true,
    });
    const executeSpy = vi.spyOn(db, "execute").mockImplementation((async () => {
      await db.update(invitation).set({ email: "other@example.com" })
        .where(eq(invitation.id, "invite_1"));
      return { rows: [{ accepted: false }] } as never;
    }) as unknown as typeof db.execute);

    try {
      await expect(
        acceptDashboardSsoInvite(db, auth, {
          organizationSlug: "ai-workflow",
          inviteId: "invite_1",
          user: { id: ssoUser.id, email: "sso-race@example.com" },
          now: new Date("2026-06-26T00:00:00.000Z"),
        }),
      ).rejects.toMatchObject({
        statusCode: 403,
        message: "Invite does not match signed-in user",
      });
    } finally {
      executeSpy.mockRestore();
    }

    const memberships = await db.select().from(member)
      .where(eq(member.userId, ssoUser.id));
    expect(memberships).toHaveLength(0);
    const [unchanged] = await db.select({ status: invitation.status })
      .from(invitation)
      .where(eq(invitation.id, "invite_1"));
    expect(unchanged).toEqual({ status: "pending" });
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
