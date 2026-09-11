/* oxlint-disable eslint/max-lines-per-function */
import { randomUUID } from "node:crypto";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq, isNotNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { Db } from "../client.js";
import {
  account,
  invitation,
  member,
  organization,
  ssoProvider,
  verification,
} from "../schema.js";

type InviteRecord = {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Date;
  createdAt: Date;
};

type ExecuteRows<T> = { rows: T[] };

/** Persistence boundary for custom dashboard authentication writes. */
export function createAuthRepository(db: Db) {
  return {
    async hasCredentialAccount(userId: string): Promise<boolean> {
      const [credential] = await db
        .select({ id: account.id })
        .from(account)
        .where(
          and(
            eq(account.userId, userId),
            eq(account.providerId, "credential"),
            isNotNull(account.password),
          ),
        )
        .limit(1);
      return Boolean(credential);
    },

    async cancelPendingInvite(inviteId: string) {
      const [updated] = await db
        .update(invitation)
        .set({ status: "canceled" })
        .where(and(eq(invitation.id, inviteId), eq(invitation.status, "pending")))
        .returning();
      return updated ?? null;
    },

    async deleteResetPasswordVerification(token: string): Promise<void> {
      await db
        .delete(verification)
        .where(eq(verification.identifier, `reset-password:${token}`));
    },

    async updateMemberRole(id: string, role: "admin" | "member"): Promise<void> {
      await db.update(member).set({ role }).where(eq(member.id, id));
    },

    async ensureOrganization(input: { name: string; slug: string }) {
      const [created] = await db
        .insert(organization)
        .values({ id: randomUUID(), ...input })
        .onConflictDoNothing({ target: organization.slug })
        .returning();
      if (created) return { organization: created, created: true };
      const [existing] = await db
        .select()
        .from(organization)
        .where(eq(organization.slug, input.slug))
        .limit(1);
      if (!existing) throw new Error("Dashboard organization was not found after bootstrap");
      if (existing.name === input.name) return { organization: existing, created: false };
      const [updated] = await db
        .update(organization)
        .set({ name: input.name, updatedAt: new Date() })
        .where(eq(organization.id, existing.id))
        .returning();
      return { organization: updated, created: false };
    },

    async ensureOwnerMembership(organizationId: string, userId: string) {
      const [created] = await db
        .insert(member)
        .values({ id: randomUUID(), organizationId, userId, role: "owner" })
        .onConflictDoNothing({ target: [member.organizationId, member.userId] })
        .returning();
      if (created) return { created: true, updated: false };
      const [existing] = await db
        .select()
        .from(member)
        .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
        .limit(1);
      if (!existing) throw new Error("Dashboard owner membership was not found after bootstrap");
      if (existing.role === "owner") return { created: false, updated: false };
      await db.update(member).set({ role: "owner" }).where(eq(member.id, existing.id));
      return { created: false, updated: true };
    },

    async ensureSsoProvider(input: {
      providerId: string;
      organizationId: string;
      userId: string;
      issuer: string;
      oidcConfig: string;
      domain: string;
    }) {
      const providerData = { ...input, samlConfig: null, domainVerified: true };
      const [created] = await db
        .insert(ssoProvider)
        .values({ id: randomUUID(), ...providerData })
        .onConflictDoNothing({ target: ssoProvider.providerId })
        .returning();
      if (created) return { created: true, updated: false };
      const [existing] = await db
        .select()
        .from(ssoProvider)
        .where(eq(ssoProvider.providerId, input.providerId))
        .limit(1);
      if (!existing) throw new Error("Dashboard SSO provider was not found after bootstrap");
      const changed = existing.issuer !== input.issuer ||
        existing.oidcConfig !== input.oidcConfig ||
        existing.samlConfig !== null || existing.userId !== input.userId ||
        existing.organizationId !== input.organizationId ||
        existing.domain !== input.domain || existing.domainVerified !== true;
      if (!changed) return { created: false, updated: false };
      await db.update(ssoProvider).set(providerData).where(eq(ssoProvider.providerId, input.providerId));
      return { created: false, updated: true };
    },
    async createInviteWithDelivery(input: {
      inviteId: string;
      deliveryId: string;
      organizationId: string;
      email: string;
      expiresAt: Date;
      inviterId: string;
    }): Promise<InviteRecord> {
      const result = await db.execute(sql`
        with created as (
          insert into invitation (id, organization_id, email, role, status, expires_at, inviter_id)
          values (${input.inviteId}, ${input.organizationId}, ${input.email}, 'member', 'pending', ${input.expiresAt}, ${input.inviterId})
          returning id, email, role, status, expires_at as "expiresAt", created_at as "createdAt"
        ), delivery as (
          insert into invite_email_delivery (id, invitation_id, status)
          select ${input.deliveryId}, id, 'pending_send' from created
        )
        select id, email, role, status, "expiresAt", "createdAt" from created
      `) as ExecuteRows<InviteRecord>;
      const row = result.rows[0];
      if (!row) throw new Error("Invite was not created");
      return { ...row, expiresAt: new Date(row.expiresAt), createdAt: new Date(row.createdAt) };
    },

    async refreshInviteWithDelivery(input: {
      inviteId: string;
      deliveryId: string;
      expiresAt: Date;
    }): Promise<InviteRecord | null> {
      const result = await db.execute(sql`
        with refreshed as (
          update invitation
          set expires_at = ${input.expiresAt}, status = 'pending'
          where id = ${input.inviteId} and status = 'pending'
          returning id, email, role, status, expires_at as "expiresAt", created_at as "createdAt"
        ), delivery as (
          insert into invite_email_delivery (id, invitation_id, status)
          select ${input.deliveryId}, id, 'pending_send' from refreshed
        )
        select id, email, role, status, "expiresAt", "createdAt" from refreshed
      `) as ExecuteRows<InviteRecord>;
      const row = result.rows[0];
      return row ? { ...row, expiresAt: new Date(row.expiresAt), createdAt: new Date(row.createdAt) } : null;
    },

    async acceptPasswordInvite(input: {
      organizationId: string;
      inviteId: string;
      now: Date;
      userId: string;
      userEmail: string;
      userName: string;
      newPasswordHash: string | null;
      accountId: string | null;
      membershipId: string;
    }): Promise<boolean> {
      const result = await db.execute(sql`
        with pending as (
          select id, organization_id, role
          from invitation
          where id = ${input.inviteId}
            and organization_id = ${input.organizationId}
            and status = 'pending'
            and expires_at > ${input.now}
            and role in ('owner', 'admin', 'member')
          for update
        ), created_user as (
          insert into "user" (id, email, name, email_verified)
          select ${input.userId}, ${input.userEmail}, ${input.userName}, true
          from pending
          where ${input.newPasswordHash}::text is not null
          returning id
        ), accepted_user as (
          select id from created_user
          union all
          select existing.id
          from pending
          inner join "user" existing on existing.id = ${input.userId}
          where ${input.newPasswordHash}::text is null
        ), created_account as (
          insert into account (id, user_id, account_id, provider_id, password)
          select ${input.accountId}, accepted_user.id, accepted_user.id, 'credential', ${input.newPasswordHash}
          from accepted_user
          where ${input.newPasswordHash}::text is not null
          returning user_id
        ), credential_ready as (
          select user_id from created_account
          union all
          select id from accepted_user
          where ${input.newPasswordHash}::text is null
        ), membership as (
          insert into member (id, organization_id, user_id, role)
          select ${input.membershipId}, pending.organization_id, credential_ready.user_id, pending.role
          from pending
          inner join credential_ready on credential_ready.user_id = ${input.userId}
          on conflict (organization_id, user_id) do update set role = case
            when excluded.role = 'owner' then 'owner'
            when excluded.role = 'admin' and member.role <> 'owner' then 'admin'
            else member.role
          end
          returning user_id
        ), accepted as (
          update invitation i set status = 'accepted'
          from pending p, membership m
          where i.id = p.id
            and i.status = 'pending'
            and m.user_id = ${input.userId}
          returning i.id
        )
        select exists(select 1 from accepted) as accepted
      `) as ExecuteRows<{ accepted: boolean }>;
      return result.rows[0]?.accepted === true;
    },

    async acceptSsoInvite(input: {
      organizationId: string;
      inviteId: string;
      now: Date;
      userId: string;
      userEmail: string;
      membershipId: string;
    }): Promise<boolean> {
      const result = await db.execute(sql`
        with pending as (
          select id, organization_id, role, email
          from invitation
          where id = ${input.inviteId}
            and organization_id = ${input.organizationId}
            and status = 'pending'
            and expires_at > ${input.now}
            and role in ('owner', 'admin', 'member')
            and lower(btrim(email)) = ${input.userEmail}
          for update
        ), membership as (
          insert into member (id, organization_id, user_id, role)
          select ${input.membershipId}, organization_id, ${input.userId}, role from pending
          on conflict (organization_id, user_id) do update set role = case
            when excluded.role = 'owner' then 'owner'
            when excluded.role = 'admin' and member.role <> 'owner' then 'admin'
            else member.role
          end
          returning user_id
        ), accepted as (
          update invitation i set status = 'accepted'
          from pending p, membership m
          where i.id = p.id
            and i.status = 'pending'
            and m.user_id = ${input.userId}
          returning i.id
        )
        select exists(select 1 from accepted) as accepted
      `) as ExecuteRows<{ accepted: boolean }>;
      return result.rows[0]?.accepted === true;
    },
  };
}

/** Better Auth adapter construction is database wiring, not a custom write. */
export function createBetterAuthAdapter(db: Db) {
  return drizzleAdapter(db, { provider: "pg" });
}
