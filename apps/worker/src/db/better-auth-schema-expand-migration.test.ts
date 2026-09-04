import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";

import {
  createAuth,
  DASHBOARD_SSO_PROVIDER_ID,
  seedAuthUser,
} from "../auth.js";
import type { Db } from "./client.js";
import { account, ssoProvider } from "./schema.js";
import * as schema from "./schema.js";

const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));
const expandMigration = readFileSync(
  `${migrationsDir}0058_better_auth_schema_expand.sql`,
  "utf8",
);
const openClients: PGlite[] = [];

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

async function migrateThrough(lastPrefix: string): Promise<PGlite> {
  const client = new PGlite();
  openClients.push(client);
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql") && file.slice(0, 4) <= lastPrefix)
    .sort();
  for (const file of files) {
    await client.exec(readFileSync(`${migrationsDir}${file}`, "utf8"));
  }
  return client;
}

async function authRowCounts(client: PGlite) {
  const result = await client.query<{
    accounts: number;
    clients: number;
    refresh_tokens: number;
    access_tokens: number;
    consents: number;
  }>(`
    SELECT
      (SELECT count(*)::int FROM account) AS accounts,
      (SELECT count(*)::int FROM oauth_client) AS clients,
      (SELECT count(*)::int FROM oauth_refresh_token) AS refresh_tokens,
      (SELECT count(*)::int FROM oauth_access_token) AS access_tokens,
      (SELECT count(*)::int FROM oauth_consent) AS consents
  `);
  return result.rows[0];
}

describe("0058 Better Auth schema expand migration", () => {
  it("backfills populated 1.6 data, preserves rollback fields and rows, and is retry-safe", async () => {
    const client = await migrateThrough("0057");
    await client.exec(`
      INSERT INTO "user" (id, name, email, email_verified) VALUES
        ('legacy-owner', 'Legacy Owner', 'legacy-owner@example.com', true),
        ('legacy-sso', 'Legacy SSO', 'legacy-sso@example.com', true);
      INSERT INTO sso_provider (
        id, issuer, user_id, provider_id, domain, domain_verified
      ) VALUES (
        'legacy-provider', 'https://idp.example.com', 'legacy-owner',
        'workspace-sso', 'example.com', true
      );
      INSERT INTO account (id, user_id, account_id, provider_id, password) VALUES
        ('legacy-credential', 'legacy-owner', 'legacy-owner', 'credential', 'hash'),
        ('legacy-sso-account', 'legacy-sso', 'legacy-subject', 'workspace-sso', null);
      INSERT INTO oauth_client (
        id, client_id, redirect_uris, public, type
      ) VALUES (
        'legacy-client-row', 'legacy-client', ARRAY['https://client.example/callback'],
        true, 'native'
      );
      INSERT INTO oauth_refresh_token (
        id, token, client_id, user_id, scopes
      ) VALUES (
        'legacy-refresh', 'legacy-refresh-token', 'legacy-client',
        'legacy-owner', ARRAY['offline_access']
      );
      INSERT INTO oauth_access_token (
        id, token, client_id, user_id, refresh_id, scopes
      ) VALUES (
        'legacy-access', 'legacy-access-token', 'legacy-client',
        'legacy-owner', 'legacy-refresh', ARRAY['mcp:read']
      );
      INSERT INTO oauth_consent (
        id, client_id, user_id, scopes
      ) VALUES (
        'legacy-consent', 'legacy-client', 'legacy-owner', ARRAY['mcp:read']
      );
    `);
    const before = await authRowCounts(client);

    await client.exec(expandMigration);
    // Stronger than the deploy journal no-op: the SQL itself remains harmless
    // if an operator retries it after a completed run.
    await client.exec(expandMigration);

    const issuers = await client.query<{
      id: string;
      issuer: string;
      provider_id: string;
    }>(`
      SELECT id, issuer, provider_id
      FROM account
      ORDER BY id
    `);
    expect(issuers.rows).toEqual([
      {
        id: "legacy-credential",
        issuer: "local:credential",
        provider_id: "credential",
      },
      {
        id: "legacy-sso-account",
        issuer: "https://idp.example.com",
        provider_id: "workspace-sso",
      },
    ]);
    await expect(authRowCounts(client)).resolves.toEqual(before);

    const legacyClient = await client.query<{
      public: boolean;
      type: string;
      client_credentials_scopes: string[];
      dpop_bound_access_tokens: boolean;
    }>(`
      SELECT public, type, client_credentials_scopes, dpop_bound_access_tokens
      FROM oauth_client
      WHERE client_id = 'legacy-client'
    `);
    expect(legacyClient.rows).toEqual([
      {
        public: true,
        type: "native",
        client_credentials_scopes: [],
        dpop_bound_access_tokens: false,
      },
    ]);

    const issuerColumn = await client.query<{ is_nullable: string }>(`
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'account'
        AND column_name = 'issuer'
    `);
    expect(issuerColumn.rows).toEqual([{ is_nullable: "NO" }]);

    const accountIndexes = await client.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'account'
        AND indexname IN (
          'account_issuer_accountId_uidx',
          'account_provider_id_account_id_unique'
        )
      ORDER BY indexname
    `);
    expect(accountIndexes.rows.map(({ indexname }) => indexname)).toEqual([
      "account_issuer_accountId_uidx",
      "account_provider_id_account_id_unique",
    ]);

    const newTables = await client.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'oauth_client_assertion',
          'oauth_client_resource',
          'oauth_resource'
        )
      ORDER BY table_name
    `);
    expect(newTables.rows.map(({ table_name }) => table_name)).toEqual([
      "oauth_client_assertion",
      "oauth_client_resource",
      "oauth_resource",
    ]);
  }, 30_000);

  it("keeps Better Auth 1.6.30 credential and configured-SSO writers working", async () => {
    const client = await migrateThrough("0058");
    const db = drizzle({ client, schema }) as unknown as Db;
    const auth = createAuth(db, {
      secret: "x".repeat(32),
      baseURL: "http://localhost:3000",
      trustedOrigins: ["http://localhost:3001"],
    });

    await seedAuthUser(auth, {
      email: "old-writer@example.com",
      password: "password123",
      name: "Old Writer",
    });
    const ctx = await auth.$context;
    const ssoUser = await ctx.internalAdapter.createUser({
      email: "old-sso-writer@example.com",
      name: "Old SSO Writer",
      emailVerified: true,
    });
    await db.insert(ssoProvider).values({
      id: "old-writer-provider",
      issuer: "https://idp.old-writer.example",
      userId: ssoUser.id,
      providerId: DASHBOARD_SSO_PROVIDER_ID,
      domain: "old-writer.example",
      domainVerified: true,
    });
    await ctx.internalAdapter.linkAccount({
      userId: ssoUser.id,
      providerId: DASHBOARD_SSO_PROVIDER_ID,
      accountId: "old-sso-subject",
    });

    const rows = await db
      .select({ providerId: account.providerId, issuer: account.issuer })
      .from(account);
    expect(rows).toEqual(
      expect.arrayContaining([
        { providerId: "credential", issuer: "local:credential" },
        {
          providerId: DASHBOARD_SSO_PROVIDER_ID,
          issuer: "https://idp.old-writer.example",
        },
      ]),
    );

    await expect(
      auth.api.signInEmail({
        body: { email: "old-writer@example.com", password: "password123" },
      }),
    ).resolves.toBeDefined();

    await expect(
      client.exec(`
        INSERT INTO account (id, user_id, account_id, provider_id)
        VALUES ('unknown-old-writer', '${ssoUser.id}', 'subject', 'unknown-provider')
      `),
    ).rejects.toThrow(/no issuer for unknown provider unknown-provider/i);
  }, 30_000);

  it("keeps SSO issuers immutable while allowing non-issuer configuration updates", async () => {
    const client = await migrateThrough("0058");
    await client.exec(`
      INSERT INTO "user" (id, name, email, email_verified)
      VALUES ('legacy-bootstrap-owner', 'Legacy Bootstrap', 'legacy-bootstrap@example.com', true);
      INSERT INTO sso_provider (
        id, issuer, user_id, provider_id, domain, domain_verified
      ) VALUES (
        'legacy-bootstrap-provider', 'https://idp.original.example',
        'legacy-bootstrap-owner', 'legacy-bootstrap-sso', 'original.example', true
      );
      INSERT INTO account (id, user_id, account_id, provider_id)
      VALUES (
        'legacy-bootstrap-account', 'legacy-bootstrap-owner',
        'legacy-subject', 'legacy-bootstrap-sso'
      );
    `);

    await expect(
      client.exec(`
        UPDATE sso_provider
        SET issuer = 'https://idp.changed.example'
        WHERE provider_id = 'legacy-bootstrap-sso'
      `),
    ).rejects.toThrow(
      /issuer cannot change during the Better Auth compatibility window for provider legacy-bootstrap-sso/i,
    );

    const identity = await client.query<{
      account_issuer: string;
      provider_issuer: string;
    }>(`
      SELECT account.issuer AS account_issuer, provider.issuer AS provider_issuer
      FROM account
      JOIN sso_provider AS provider
        ON provider.provider_id = account.provider_id
      WHERE account.id = 'legacy-bootstrap-account'
    `);
    expect(identity.rows).toEqual([
      {
        account_issuer: "https://idp.original.example",
        provider_issuer: "https://idp.original.example",
      },
    ]);

    await client.exec(`
      INSERT INTO sso_provider (id, issuer, user_id, provider_id, domain)
      VALUES (
        'unlinked-provider', 'https://unlinked.original.example',
        'legacy-bootstrap-owner', 'unlinked-sso', 'unlinked.example'
      );
    `);

    await expect(
      client.exec(`
        UPDATE sso_provider
        SET issuer = 'https://unlinked.changed.example'
        WHERE provider_id = 'unlinked-sso'
      `),
    ).rejects.toThrow(
      /issuer cannot change during the Better Auth compatibility window for provider unlinked-sso/i,
    );

    await client.exec(`
      UPDATE sso_provider
      SET domain = 'updated-unlinked.example', domain_verified = true
      WHERE provider_id = 'unlinked-sso'
    `);
    const unlinked = await client.query<{
      domain: string;
      domain_verified: boolean;
      issuer: string;
    }>(`
      SELECT domain, domain_verified, issuer
      FROM sso_provider
      WHERE provider_id = 'unlinked-sso'
    `);
    expect(unlinked.rows).toEqual([
      {
        domain: "updated-unlinked.example",
        domain_verified: true,
        issuer: "https://unlinked.original.example",
      },
    ]);
  }, 30_000);

  it("aborts before DDL when a legacy account provider has no SSO mapping", async () => {
    const client = await migrateThrough("0057");
    await client.exec(`
      INSERT INTO "user" (id, name, email)
      VALUES ('unknown-user', 'Unknown User', 'unknown@example.com');
      INSERT INTO account (id, user_id, account_id, provider_id)
      VALUES ('unknown-account', 'unknown-user', 'unknown-subject', 'unknown-provider');
    `);

    await expect(client.exec(expandMigration)).rejects.toThrow(
      /unknown account provider\(s\): unknown-provider/i,
    );
    const issuerColumn = await client.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'account'
        AND column_name = 'issuer'
    `);
    expect(issuerColumn.rows).toEqual([{ count: 0 }]);
  }, 30_000);

  it("aborts before DDL when SSO mappings would collide on the new identity key", async () => {
    const client = await migrateThrough("0057");
    await client.exec(`
      INSERT INTO "user" (id, name, email)
      VALUES ('collision-user', 'Collision User', 'collision@example.com');
      INSERT INTO sso_provider (id, issuer, user_id, provider_id, domain) VALUES
        ('provider-a', 'https://shared-idp.example', 'collision-user', 'sso-a', 'a.example'),
        ('provider-b', 'https://shared-idp.example', 'collision-user', 'sso-b', 'b.example');
      INSERT INTO account (id, user_id, account_id, provider_id) VALUES
        ('account-a', 'collision-user', 'shared-subject', 'sso-a'),
        ('account-b', 'collision-user', 'shared-subject', 'sso-b');
    `);

    await expect(client.exec(expandMigration)).rejects.toThrow(
      /1 \(issuer, account_id\) collision group/i,
    );
    const issuerColumn = await client.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'account'
        AND column_name = 'issuer'
    `);
    expect(issuerColumn.rows).toEqual([{ count: 0 }]);
  }, 30_000);
});
