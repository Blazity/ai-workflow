import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../db/client.js";
import {
  account,
  member,
  organization,
  user,
} from "../../db/schema.js";
import { createTestDb } from "../../db/test-db.js";
import {
  getDashboardActor,
  listDashboardUsers,
  updateDashboardUserRole,
} from "./users-read.js";

let db: Db;

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

  await db.insert(account).values([
    {
      id: "account_owner_password",
      userId: "user_owner",
      accountId: "user_owner",
      providerId: "credential",
    },
    {
      id: "account_admin_sso",
      userId: "user_admin",
      accountId: "admin@example.com",
      providerId: "workspace-sso",
    },
    {
      id: "account_member_password",
      userId: "user_member",
      accountId: "user_member",
      providerId: "credential",
    },
    {
      id: "account_member_sso",
      userId: "user_member",
      accountId: "member@example.com",
      providerId: "workspace-sso",
    },
  ]);
});

describe("dashboard users read model", () => {
  it("resolves the current actor role in the fixed organization", async () => {
    await expect(
      getDashboardActor(db, {
        organizationSlug: "ai-workflow",
        userId: "user_owner",
      }),
    ).resolves.toMatchObject({
      organizationId: "org_aiw",
      userId: "user_owner",
      role: "owner",
    });
  });

  it("returns null actor context for a non-member", async () => {
    await db.insert(user).values({
      id: "user_outside",
      name: "Outside",
      email: "outside@example.com",
      emailVerified: true,
    });

    await expect(
      getDashboardActor(db, {
        organizationSlug: "ai-workflow",
        userId: "user_outside",
      }),
    ).resolves.toBeNull();
  });

  it("lists members with auth method and owner-only role actions", async () => {
    const rows = await listDashboardUsers(db, {
      organizationSlug: "ai-workflow",
      actorRole: "owner",
    });

    expect(rows).toEqual([
      expect.objectContaining({
        id: "user_admin",
        email: "admin@example.com",
        role: "admin",
        authMethod: "SSO",
        actions: { canPromote: false, canDemote: true },
      }),
      expect.objectContaining({
        id: "user_member",
        email: "member@example.com",
        role: "member",
        authMethod: "Password + SSO",
        actions: { canPromote: true, canDemote: false },
      }),
      expect.objectContaining({
        id: "user_owner",
        email: "owner@example.com",
        role: "owner",
        authMethod: "Password",
        actions: { canPromote: false, canDemote: false },
      }),
    ]);
  });

  it("does not label users with no loaded account rows as password users", async () => {
    await db.insert(user).values({
      id: "user_unknown",
      name: "Unknown",
      email: "unknown@example.com",
      emailVerified: true,
    });
    await db.insert(member).values({
      id: "member_unknown",
      organizationId: "org_aiw",
      userId: "user_unknown",
      role: "member",
    });

    const rows = await listDashboardUsers(db, {
      organizationSlug: "ai-workflow",
      actorRole: "owner",
    });

    expect(rows).toContainEqual(
      expect.objectContaining({
        id: "user_unknown",
        authMethod: "Unknown",
      }),
    );
  });

  it("does not expose role actions to admins", async () => {
    const rows = await listDashboardUsers(db, {
      organizationSlug: "ai-workflow",
      actorRole: "admin",
    });

    expect(rows.map((row) => row.actions)).toEqual([
      { canPromote: false, canDemote: false },
      { canPromote: false, canDemote: false },
      { canPromote: false, canDemote: false },
    ]);
  });

  it("lets owner promote a member but rejects admin role changes", async () => {
    await expect(
      updateDashboardUserRole(db, {
        organizationSlug: "ai-workflow",
        actorRole: "owner",
        targetUserId: "user_member",
        nextRole: "admin",
      }),
    ).resolves.toMatchObject({ role: "admin" });

    await expect(
      updateDashboardUserRole(db, {
        organizationSlug: "ai-workflow",
        actorRole: "admin",
        targetUserId: "user_member",
        nextRole: "member",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
