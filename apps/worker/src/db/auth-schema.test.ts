import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq, getTableName } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import {
  invitation,
  inviteEmailDelivery,
  member,
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  organization,
  session as sessionTable,
  ssoProvider,
  user,
} from "./schema.js";
import { createTestDb } from "./test-db.js";

let db: Db;

type GeneratedColumnFixture = {
  name: string;
  sqlType: string;
  notNull: boolean;
  hasDefault: boolean;
  primary: boolean;
  unique: boolean;
};

// Captured from the Drizzle schema generated while loading the installed
// @better-auth/oauth-provider@1.6.20 plugin. SQL identifiers are mapped to
// this repository's snake_case convention; property keys remain Better Auth's
// generated camelCase adapter contract.
const OAUTH_PROVIDER_1_6_20_GENERATOR_FIXTURE = {
  oauthClient: {
    tableName: "oauth_client",
    defaults: { disabled: false },
    columns: {
      id: ["id", "text", true, false, true, false],
      clientId: ["client_id", "text", true, false, false, true],
      clientSecret: ["client_secret", "text", false, false, false, false],
      disabled: ["disabled", "boolean", false, true, false, false],
      skipConsent: ["skip_consent", "boolean", false, false, false, false],
      enableEndSession: ["enable_end_session", "boolean", false, false, false, false],
      subjectType: ["subject_type", "text", false, false, false, false],
      scopes: ["scopes", "text[]", false, false, false, false],
      userId: ["user_id", "text", false, false, false, false],
      createdAt: ["created_at", "timestamp", false, false, false, false],
      updatedAt: ["updated_at", "timestamp", false, false, false, false],
      name: ["name", "text", false, false, false, false],
      uri: ["uri", "text", false, false, false, false],
      icon: ["icon", "text", false, false, false, false],
      contacts: ["contacts", "text[]", false, false, false, false],
      tos: ["tos", "text", false, false, false, false],
      policy: ["policy", "text", false, false, false, false],
      softwareId: ["software_id", "text", false, false, false, false],
      softwareVersion: ["software_version", "text", false, false, false, false],
      softwareStatement: ["software_statement", "text", false, false, false, false],
      redirectUris: ["redirect_uris", "text[]", true, false, false, false],
      postLogoutRedirectUris: ["post_logout_redirect_uris", "text[]", false, false, false, false],
      tokenEndpointAuthMethod: ["token_endpoint_auth_method", "text", false, false, false, false],
      grantTypes: ["grant_types", "text[]", false, false, false, false],
      responseTypes: ["response_types", "text[]", false, false, false, false],
      public: ["public", "boolean", false, false, false, false],
      type: ["type", "text", false, false, false, false],
      requirePKCE: ["require_pkce", "boolean", false, false, false, false],
      referenceId: ["reference_id", "text", false, false, false, false],
      metadata: ["metadata", "jsonb", false, false, false, false],
    },
    indexes: [{ name: "oauthClient_userId_idx", columns: ["user_id"] }],
  },
  oauthRefreshToken: {
    tableName: "oauth_refresh_token",
    defaults: {},
    columns: {
      id: ["id", "text", true, false, true, false],
      token: ["token", "text", true, false, false, true],
      clientId: ["client_id", "text", true, false, false, false],
      sessionId: ["session_id", "text", false, false, false, false],
      userId: ["user_id", "text", true, false, false, false],
      referenceId: ["reference_id", "text", false, false, false, false],
      expiresAt: ["expires_at", "timestamp", false, false, false, false],
      createdAt: ["created_at", "timestamp", false, false, false, false],
      revoked: ["revoked", "timestamp", false, false, false, false],
      authTime: ["auth_time", "timestamp", false, false, false, false],
      scopes: ["scopes", "text[]", true, false, false, false],
    },
    indexes: [
      { name: "oauthRefreshToken_clientId_idx", columns: ["client_id"] },
      { name: "oauthRefreshToken_sessionId_idx", columns: ["session_id"] },
      { name: "oauthRefreshToken_userId_idx", columns: ["user_id"] },
      { name: "oauth_refresh_token_expires_at_idx", columns: ["expires_at"] },
    ],
  },
  oauthAccessToken: {
    tableName: "oauth_access_token",
    defaults: {},
    columns: {
      id: ["id", "text", true, false, true, false],
      token: ["token", "text", false, false, false, true],
      clientId: ["client_id", "text", true, false, false, false],
      sessionId: ["session_id", "text", false, false, false, false],
      userId: ["user_id", "text", false, false, false, false],
      referenceId: ["reference_id", "text", false, false, false, false],
      refreshId: ["refresh_id", "text", false, false, false, false],
      expiresAt: ["expires_at", "timestamp", false, false, false, false],
      createdAt: ["created_at", "timestamp", false, false, false, false],
      scopes: ["scopes", "text[]", true, false, false, false],
    },
    indexes: [
      { name: "oauthAccessToken_clientId_idx", columns: ["client_id"] },
      { name: "oauthAccessToken_sessionId_idx", columns: ["session_id"] },
      { name: "oauthAccessToken_userId_idx", columns: ["user_id"] },
      { name: "oauthAccessToken_refreshId_idx", columns: ["refresh_id"] },
      { name: "oauth_access_token_expires_at_idx", columns: ["expires_at"] },
    ],
  },
  oauthConsent: {
    tableName: "oauth_consent",
    defaults: {},
    columns: {
      id: ["id", "text", true, false, true, false],
      clientId: ["client_id", "text", true, false, false, false],
      userId: ["user_id", "text", false, false, false, false],
      referenceId: ["reference_id", "text", false, false, false, false],
      scopes: ["scopes", "text[]", true, false, false, false],
      createdAt: ["created_at", "timestamp", false, false, false, false],
      updatedAt: ["updated_at", "timestamp", false, false, false, false],
    },
    indexes: [
      { name: "oauthConsent_clientId_idx", columns: ["client_id"] },
      { name: "oauthConsent_userId_idx", columns: ["user_id"] },
    ],
  },
} as const;

function generatedColumnConfig(table: PgTable): Record<string, GeneratedColumnFixture> {
  const config = getTableConfig(table);
  return Object.fromEntries(
    config.columns.map((column) => {
      const propertyKey = Object.entries(table).find(([, value]) => value === column)?.[0];
      if (!propertyKey) throw new Error(`No property key for ${column.name}`);
      return [
        propertyKey,
        {
          name: column.name,
          sqlType: column.getSQLType(),
          notNull: column.notNull,
          hasDefault: column.hasDefault,
          primary: column.primary,
          unique: column.isUnique,
        },
      ];
    }),
  );
}

function fixtureColumns(
  columns: Record<string, readonly [string, string, boolean, boolean, boolean, boolean]>,
): Record<string, GeneratedColumnFixture> {
  return Object.fromEntries(
    Object.entries(columns).map(([key, [name, sqlType, notNull, hasDefault, primary, unique]]) => [
      key,
      { name, sqlType, notNull, hasDefault, primary, unique },
    ]),
  );
}

function generatedDefaults(table: PgTable): Record<string, unknown> {
  const config = getTableConfig(table);
  return Object.fromEntries(
    config.columns
      .filter((column) => column.hasDefault)
      .map((column) => {
        const propertyKey = Object.entries(table).find(([, value]) => value === column)?.[0];
        if (!propertyKey) throw new Error(`No property key for ${column.name}`);
        return [propertyKey, column.default];
      }),
  );
}

function indexConfig(table: PgTable) {
  return getTableConfig(table).indexes
    .map((tableIndex) => {
      const name = tableIndex.config.name;
      if (typeof name !== "string") {
        throw new Error("Expected a named table index");
      }
      return {
        name,
        columns: tableIndex.config.columns.map((column) => {
          if (!("name" in column) || typeof column.name !== "string") {
            throw new Error("Expected an indexed table column");
          }
          return column.name;
        }),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function fixtureIndexes(indexes: readonly { name: string; columns: readonly string[] }[]) {
  return indexes
    .map((tableIndex) => ({
      name: tableIndex.name,
      columns: [...tableIndex.columns],
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

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

describe("Better Auth OAuth provider 1.6.20 schema", () => {
  it.each([
    ["oauthClient", oauthClient],
    ["oauthRefreshToken", oauthRefreshToken],
    ["oauthAccessToken", oauthAccessToken],
    ["oauthConsent", oauthConsent],
  ] as const)("matches the generated %s Drizzle shape", (fixtureKey, table) => {
    const fixture = OAUTH_PROVIDER_1_6_20_GENERATOR_FIXTURE[fixtureKey];

    expect(getTableName(table)).toBe(fixture.tableName);
    expect(generatedColumnConfig(table)).toEqual(fixtureColumns(fixture.columns));
    expect(generatedDefaults(table)).toEqual(fixture.defaults);
    expect(indexConfig(table)).toEqual(fixtureIndexes(fixture.indexes));
  });

  it("preserves generated OAuth client, user, session and refresh-token references", () => {
    const references = [oauthClient, oauthRefreshToken, oauthAccessToken, oauthConsent]
      .flatMap((table) =>
        getTableConfig(table).foreignKeys.map((foreignKey) => {
          const reference = foreignKey.reference();
          return {
            table: getTableName(table),
            columns: reference.columns.map((column) => column.name),
            foreignTable: getTableName(reference.foreignTable),
            foreignColumns: reference.foreignColumns.map((column) => column.name),
            onDelete: foreignKey.onDelete,
            onUpdate: foreignKey.onUpdate,
          };
        }),
      )
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

    const expectedReferences = [
      { table: "oauth_client", columns: ["user_id"], foreignTable: "user", foreignColumns: ["id"], onDelete: "cascade", onUpdate: "no action" },
      { table: "oauth_refresh_token", columns: ["client_id"], foreignTable: "oauth_client", foreignColumns: ["client_id"], onDelete: "cascade", onUpdate: "no action" },
      { table: "oauth_refresh_token", columns: ["session_id"], foreignTable: "session", foreignColumns: ["id"], onDelete: "set null", onUpdate: "no action" },
      { table: "oauth_refresh_token", columns: ["user_id"], foreignTable: "user", foreignColumns: ["id"], onDelete: "cascade", onUpdate: "no action" },
      { table: "oauth_access_token", columns: ["client_id"], foreignTable: "oauth_client", foreignColumns: ["client_id"], onDelete: "cascade", onUpdate: "no action" },
      { table: "oauth_access_token", columns: ["session_id"], foreignTable: "session", foreignColumns: ["id"], onDelete: "set null", onUpdate: "no action" },
      { table: "oauth_access_token", columns: ["user_id"], foreignTable: "user", foreignColumns: ["id"], onDelete: "cascade", onUpdate: "no action" },
      { table: "oauth_access_token", columns: ["refresh_id"], foreignTable: "oauth_refresh_token", foreignColumns: ["id"], onDelete: "cascade", onUpdate: "no action" },
      { table: "oauth_consent", columns: ["client_id"], foreignTable: "oauth_client", foreignColumns: ["client_id"], onDelete: "cascade", onUpdate: "no action" },
      { table: "oauth_consent", columns: ["user_id"], foreignTable: "user", foreignColumns: ["id"], onDelete: "cascade", onUpdate: "no action" },
    ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

    expect(references).toEqual(expectedReferences);
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
