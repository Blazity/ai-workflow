import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import {
  invitation,
  inviteEmailDelivery,
  member,
  organization,
  session as sessionTable,
  ssoProvider,
  user,
} from "./schema.js";
import { createTestDb } from "./test-db.js";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

async function seedOwner(): Promise<void> {
  await db.insert(user).values({
    id: "user_owner",
    name: "Owner",
    email: "owner@acme.test",
    emailVerified: true,
  });
}

async function seedOrganization(): Promise<void> {
  await db.insert(organization).values({
    id: "org_acme",
    name: "Acme",
    slug: "acme",
  });
}

describe("Better Auth organization and SSO schema", () => {
  it("persists an owner member and stores the active organization on the session", async () => {
    await seedOwner();
    await seedOrganization();

    await db.insert(member).values({
      id: "member_owner",
      organizationId: "org_acme",
      userId: "user_owner",
      role: "owner",
    });
    await db.insert(sessionTable).values({
      id: "session_owner",
      userId: "user_owner",
      token: "session-token-owner",
      expiresAt: new Date("2026-07-01T00:00:00.000Z"),
      activeOrganizationId: "org_acme",
    });

    const [owner] = await db
      .select({ role: member.role })
      .from(member)
      .where(eq(member.id, "member_owner"));
    const [session] = await db
      .select({ activeOrganizationId: sessionTable.activeOrganizationId })
      .from(sessionTable)
      .where(eq(sessionTable.id, "session_owner"));

    expect(owner?.role).toBe("owner");
    expect(session?.activeOrganizationId).toBe("org_acme");
  });

  it("rejects duplicate organization memberships for the same user", async () => {
    await seedOwner();
    await seedOrganization();

    await db.insert(member).values({
      id: "member_owner",
      organizationId: "org_acme",
      userId: "user_owner",
      role: "owner",
    });

    await expect(
      db.insert(member).values({
        id: "member_owner_duplicate",
        organizationId: "org_acme",
        userId: "user_owner",
        role: "admin",
      }),
    ).rejects.toThrow();
  });

  it("persists an OIDC SSO provider for an organization", async () => {
    await seedOwner();
    await seedOrganization();

    const oidcConfig = JSON.stringify({
      issuer: "https://idp.acme.test",
      clientId: "client_acme",
      discoveryEndpoint: "https://idp.acme.test/.well-known/openid-configuration",
      pkce: true,
    });

    await db.insert(ssoProvider).values({
      id: "sso_acme",
      issuer: "https://idp.acme.test",
      oidcConfig,
      userId: "user_owner",
      providerId: "acme-oidc",
      organizationId: "org_acme",
      domain: "acme.test",
    });

    const [provider] = await db
      .select({
        providerId: ssoProvider.providerId,
        domain: ssoProvider.domain,
        organizationId: ssoProvider.organizationId,
        oidcConfig: ssoProvider.oidcConfig,
      })
      .from(ssoProvider)
      .where(eq(ssoProvider.providerId, "acme-oidc"));

    expect(provider).toEqual({
      providerId: "acme-oidc",
      domain: "acme.test",
      organizationId: "org_acme",
      oidcConfig,
    });
  });

  it("persists invite email delivery metadata and cascades when the invitation is deleted", async () => {
    await seedOwner();
    await seedOrganization();
    await db.insert(invitation).values({
      id: "invite_acme",
      organizationId: "org_acme",
      email: "new.user@acme.test",
      role: "member",
      status: "pending",
      expiresAt: new Date("2026-07-01T00:00:00.000Z"),
      inviterId: "user_owner",
    });

    await db.insert(inviteEmailDelivery).values({
      id: "delivery_acme",
      invitationId: "invite_acme",
      resendEmailId: "email_123",
      status: "failed",
      error: "Mailbox unavailable",
    });

    const [delivery] = await db
      .select({
        resendEmailId: inviteEmailDelivery.resendEmailId,
        status: inviteEmailDelivery.status,
        error: inviteEmailDelivery.error,
      })
      .from(inviteEmailDelivery)
      .where(eq(inviteEmailDelivery.invitationId, "invite_acme"));

    expect(delivery).toEqual({
      resendEmailId: "email_123",
      status: "failed",
      error: "Mailbox unavailable",
    });

    await db.delete(invitation).where(eq(invitation.id, "invite_acme"));
    const deliveries = await db.select().from(inviteEmailDelivery);
    expect(deliveries).toEqual([]);
  });
});

describe("auth invariant migration preflight", () => {
  it.each([
    {
      name: "duplicate lowercased user emails",
      sql: `
        insert into "user" ("id", "name", "email") values
          ('user_a', 'User A', 'Admin@Example.com'),
          ('user_b', 'User B', 'admin@example.com');
      `,
      message: "auth invariant preflight failed: duplicate lowercased user emails",
    },
    {
      name: "duplicate account provider/account pairs",
      sql: `
        insert into "user" ("id", "name", "email") values ('user_a', 'User A', 'user@example.com');
        insert into "account" ("id", "user_id", "provider_id", "account_id") values
          ('account_a', 'user_a', 'credential', 'same'),
          ('account_b', 'user_a', 'credential', 'same');
      `,
      message: "auth invariant preflight failed: duplicate account provider/account pairs",
    },
    {
      name: "invalid invitation roles",
      sql: `
        insert into "user" ("id", "name", "email") values ('user_a', 'User A', 'user@example.com');
        insert into "organization" ("id", "name", "slug") values ('org_a', 'Org A', 'org-a');
        insert into "invitation" ("id", "organization_id", "email", "role", "expires_at", "inviter_id")
        values ('invite_a', 'org_a', 'new@example.com', 'superadmin', now(), 'user_a');
      `,
      message: "auth invariant preflight failed: invalid invitation roles",
    },
    {
      name: "invalid member roles",
      sql: `
        insert into "user" ("id", "name", "email") values ('user_a', 'User A', 'user@example.com');
        insert into "organization" ("id", "name", "slug") values ('org_a', 'Org A', 'org-a');
        insert into "member" ("id", "organization_id", "user_id", "role")
        values ('member_a', 'org_a', 'user_a', 'superadmin');
      `,
      message: "auth invariant preflight failed: invalid member roles",
    },
  ])("fails clearly before enforcing constraints for $name", async ({ sql, message }) => {
    const client = await createMigratedClientThrough("0006");
    await client.exec(sql);

    await expect(applyMigration(client, "0007_auth_invariants.sql")).rejects.toThrow(
      message,
    );
  });
});

async function createMigratedClientThrough(lastPrefix: string): Promise<PGlite> {
  const client = new PGlite();
  const dir = fileURLToPath(new URL("../../drizzle/", import.meta.url));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && f.slice(0, 4) <= lastPrefix)
    .sort();
  for (const file of files) {
    await client.exec(readFileSync(`${dir}${file}`, "utf8"));
  }
  return client;
}

async function applyMigration(client: PGlite, file: string): Promise<void> {
  const dir = fileURLToPath(new URL("../../drizzle/", import.meta.url));
  await client.exec(readFileSync(`${dir}${file}`, "utf8"));
}
