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
