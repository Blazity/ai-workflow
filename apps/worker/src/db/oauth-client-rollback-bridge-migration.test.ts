import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));
const bridgeMigration = readFileSync(
  `${migrationsDir}0059_oauth_client_rollback_bridge.sql`,
  "utf8",
);
const openClients: PGlite[] = [];

type CompatibilityRow = {
  client_id: string;
  token_endpoint_auth_method: string | null;
  application_type: string | null;
  public: boolean | null;
  type: string | null;
};

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

async function migrateThrough0058(): Promise<PGlite> {
  const client = new PGlite();
  openClients.push(client);
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql") && file.slice(0, 4) <= "0058")
    .sort();
  for (const file of files) {
    await client.exec(readFileSync(`${migrationsDir}${file}`, "utf8"));
  }
  return client;
}

async function compatibilityRows(client: PGlite): Promise<CompatibilityRow[]> {
  const result = await client.query<CompatibilityRow>(`
    SELECT
      client_id,
      token_endpoint_auth_method,
      application_type,
      public,
      type
    FROM oauth_client
    ORDER BY client_id
  `);
  return result.rows;
}

async function expectCheckFailure(
  action: Promise<unknown>,
  clientId: string,
): Promise<void> {
  let caught: unknown;
  try {
    await action;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error & { code?: string }).code).toBe("23514");
  expect((caught as Error).message).toContain(clientId);
}

describe("0059 OAuth client rollback bridge migration", () => {
  it("backfills the full matrix, dual-writes both runtimes, rejects conflicts, and is retry-safe", async () => {
    const client = await migrateThrough0058();
    await client.exec(`
      INSERT INTO oauth_client (
        id, client_id, client_secret, name, redirect_uris, metadata,
        token_endpoint_auth_method, application_type, public, type
      ) VALUES
        ('01', 'modern-none-native', 'keep-secret', 'Keep me', ARRAY['https://client.example/native'], '{"keep":true}', 'none', 'native', NULL, NULL),
        ('02', 'modern-none-web', NULL, NULL, ARRAY['https://client.example/web'], NULL, 'none', 'web', NULL, NULL),
        ('03', 'modern-none-null', NULL, NULL, ARRAY['https://client.example/callback'], NULL, 'none', NULL, NULL, NULL),
        ('04', 'modern-basic-web', NULL, NULL, ARRAY['https://client.example/callback'], NULL, 'client_secret_basic', 'web', NULL, NULL),
        ('05', 'modern-post-null', NULL, NULL, ARRAY['https://client.example/callback'], NULL, 'client_secret_post', NULL, NULL, NULL),
        ('06', 'ambiguous-web', NULL, NULL, ARRAY['https://client.example/callback'], NULL, NULL, 'web', NULL, NULL),
        ('07', 'ambiguous-null', NULL, NULL, ARRAY['https://client.example/callback'], NULL, NULL, NULL, NULL, NULL),
        ('08', 'legacy-native', NULL, NULL, ARRAY['https://client.example/callback'], NULL, NULL, NULL, true, 'native'),
        ('09', 'legacy-browser', NULL, NULL, ARRAY['https://client.example/callback'], NULL, NULL, NULL, true, 'user-agent-based'),
        ('10', 'legacy-public-null', NULL, NULL, ARRAY['https://client.example/callback'], NULL, NULL, NULL, true, NULL),
        ('11', 'legacy-basic-web', NULL, NULL, ARRAY['https://client.example/callback'], NULL, 'client_secret_basic', NULL, false, 'web'),
        ('12', 'legacy-confidential-web', NULL, NULL, ARRAY['https://client.example/callback'], NULL, NULL, NULL, false, 'web'),
        ('13', 'legacy-post-null', NULL, NULL, ARRAY['https://client.example/callback'], NULL, 'client_secret_post', NULL, false, NULL),
        ('14', 'legacy-confidential-null', NULL, NULL, ARRAY['https://client.example/callback'], NULL, NULL, NULL, false, NULL)
      ;
      INSERT INTO oauth_resource (
        id, identifier, name, dpop_bound_access_tokens_required, disabled
      ) VALUES (
        'guard-resource', 'https://guard.example/mcp', 'Guard', false, false
      );
      INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at)
      SELECT 'prelink-' || id, client_id, 'https://guard.example/mcp', now()
      FROM oauth_client;
    `);

    await client.exec(bridgeMigration);
    const afterFirstRun = await compatibilityRows(client);
    expect(afterFirstRun).toEqual([
      { client_id: "ambiguous-null", token_endpoint_auth_method: null, application_type: null, public: null, type: null },
      { client_id: "ambiguous-web", token_endpoint_auth_method: null, application_type: "web", public: null, type: null },
      { client_id: "legacy-basic-web", token_endpoint_auth_method: "client_secret_basic", application_type: "web", public: false, type: "web" },
      { client_id: "legacy-browser", token_endpoint_auth_method: "none", application_type: "web", public: true, type: "user-agent-based" },
      { client_id: "legacy-confidential-null", token_endpoint_auth_method: null, application_type: null, public: false, type: null },
      { client_id: "legacy-confidential-web", token_endpoint_auth_method: null, application_type: "web", public: false, type: "web" },
      { client_id: "legacy-native", token_endpoint_auth_method: "none", application_type: "native", public: true, type: "native" },
      { client_id: "legacy-post-null", token_endpoint_auth_method: "client_secret_post", application_type: null, public: false, type: null },
      { client_id: "legacy-public-null", token_endpoint_auth_method: "none", application_type: null, public: true, type: null },
      { client_id: "modern-basic-web", token_endpoint_auth_method: "client_secret_basic", application_type: "web", public: false, type: "web" },
      { client_id: "modern-none-native", token_endpoint_auth_method: "none", application_type: "native", public: true, type: "native" },
      { client_id: "modern-none-null", token_endpoint_auth_method: "none", application_type: null, public: true, type: null },
      { client_id: "modern-none-web", token_endpoint_auth_method: "none", application_type: "web", public: true, type: "user-agent-based" },
      { client_id: "modern-post-null", token_endpoint_auth_method: "client_secret_post", application_type: null, public: false, type: null },
    ]);

    const preserved = await client.query<{
      client_secret: string;
      name: string;
      redirect_uris: string[];
      metadata: { keep: boolean };
    }>(`
      SELECT client_secret, name, redirect_uris, metadata
      FROM oauth_client
      WHERE client_id = 'modern-none-native'
    `);
    expect(preserved.rows).toEqual([
      {
        client_secret: "keep-secret",
        name: "Keep me",
        redirect_uris: ["https://client.example/native"],
        metadata: { keep: true },
      },
    ]);

    await client.exec(bridgeMigration);
    await expect(compatibilityRows(client)).resolves.toEqual(afterFirstRun);

    await client.exec(`
      INSERT INTO oauth_client (
        id, client_id, redirect_uris,
        token_endpoint_auth_method, application_type
      ) VALUES
        ('20', 'insert-modern', ARRAY['https://client.example/callback'], 'none', 'web'),
        ('21', 'insert-modern-confidential', ARRAY['https://client.example/callback'], 'client_secret_post', NULL),
        ('22', 'insert-modern-ambiguous', ARRAY['https://client.example/callback'], NULL, 'web');
      INSERT INTO oauth_client (
        id, client_id, redirect_uris, public, type
      ) VALUES
        ('23', 'insert-legacy', ARRAY['https://client.example/callback'], true, 'native'),
        ('24', 'insert-legacy-confidential', ARRAY['https://client.example/callback'], false, 'web');
      INSERT INTO oauth_client (
        id, client_id, redirect_uris,
        token_endpoint_auth_method, application_type, public, type
      ) VALUES (
        '25', 'insert-both-consistent', ARRAY['https://client.example/callback'],
        'none', 'native', true, 'native'
      );
    `);

    const inserted = (await compatibilityRows(client)).filter(({ client_id }) =>
      client_id.startsWith("insert-"),
    );
    expect(inserted).toEqual([
      { client_id: "insert-both-consistent", token_endpoint_auth_method: "none", application_type: "native", public: true, type: "native" },
      { client_id: "insert-legacy", token_endpoint_auth_method: "none", application_type: "native", public: true, type: "native" },
      { client_id: "insert-legacy-confidential", token_endpoint_auth_method: null, application_type: "web", public: false, type: "web" },
      { client_id: "insert-modern", token_endpoint_auth_method: "none", application_type: "web", public: true, type: "user-agent-based" },
      { client_id: "insert-modern-ambiguous", token_endpoint_auth_method: null, application_type: "web", public: null, type: null },
      { client_id: "insert-modern-confidential", token_endpoint_auth_method: "client_secret_post", application_type: null, public: false, type: null },
    ]);

    await client.exec(`
      UPDATE oauth_client
      SET token_endpoint_auth_method = 'client_secret_basic', application_type = 'web'
      WHERE client_id = 'insert-modern';
      UPDATE oauth_client
      SET public = true, type = 'user-agent-based'
      WHERE client_id = 'insert-legacy-confidential';
      UPDATE oauth_client
      SET public = false, type = 'web'
      WHERE client_id = 'insert-legacy';
      UPDATE oauth_client
      SET
        token_endpoint_auth_method = 'none', application_type = 'web',
        public = true, type = 'user-agent-based'
      WHERE client_id = 'insert-both-consistent';
      UPDATE oauth_client
      SET type = 'web'
      WHERE client_id = 'modern-post-null';
      UPDATE oauth_client
      SET token_endpoint_auth_method = NULL, application_type = 'web'
      WHERE client_id = 'modern-none-native';
    `);

    const updated = (await compatibilityRows(client)).filter(({ client_id }) =>
      [
        "insert-both-consistent",
        "insert-legacy",
        "insert-legacy-confidential",
        "insert-modern",
        "modern-none-native",
        "modern-post-null",
      ].includes(client_id),
    );
    expect(updated).toEqual([
      { client_id: "insert-both-consistent", token_endpoint_auth_method: "none", application_type: "web", public: true, type: "user-agent-based" },
      { client_id: "insert-legacy", token_endpoint_auth_method: null, application_type: "web", public: false, type: "web" },
      { client_id: "insert-legacy-confidential", token_endpoint_auth_method: "none", application_type: "web", public: true, type: "user-agent-based" },
      { client_id: "insert-modern", token_endpoint_auth_method: "client_secret_basic", application_type: "web", public: false, type: "web" },
      { client_id: "modern-none-native", token_endpoint_auth_method: null, application_type: "web", public: null, type: null },
      { client_id: "modern-post-null", token_endpoint_auth_method: "client_secret_post", application_type: "web", public: false, type: "web" },
    ]);

    const beforeConflict = await compatibilityRows(client);
    await expectCheckFailure(
      client.exec(`
        UPDATE oauth_client
        SET
          token_endpoint_auth_method = 'none', application_type = 'native',
          public = true, type = 'user-agent-based'
        WHERE client_id = 'insert-modern'
      `),
      "insert-modern",
    );
    await expect(compatibilityRows(client)).resolves.toEqual(beforeConflict);

    for (const [clientId, fields] of [
      ["reject-private-key", "'private_key_jwt', 'web', NULL, NULL"],
      ["reject-extension", "'extension_method', 'web', NULL, NULL"],
      ["reject-legacy-type", "NULL, NULL, true, 'desktop'"],
      ["reject-confidential-native", "'client_secret_basic', 'native', NULL, NULL"],
      ["reject-ambiguous-native", "NULL, 'native', NULL, NULL"],
    ] as const) {
      await expectCheckFailure(
        client.exec(`
          INSERT INTO oauth_client (
            id, client_id, redirect_uris,
            token_endpoint_auth_method, application_type, public, type
          ) VALUES (
            '${clientId}', '${clientId}', ARRAY['https://client.example/callback'],
            ${fields}
          )
        `),
        clientId,
      );
    }

    await expectCheckFailure(
      client.exec(`
        INSERT INTO oauth_client (
          id, client_id, redirect_uris, token_endpoint_auth_method,
          application_type, dpop_bound_access_tokens
        ) VALUES (
          'reject-dpop', 'reject-dpop', ARRAY['https://client.example/callback'],
          'client_secret_basic', 'web', true
        )
      `),
      "reject-dpop",
    );

    await expectCheckFailure(
      client.exec(`
        INSERT INTO oauth_client (
          id, client_id, redirect_uris, token_endpoint_auth_method,
          application_type, metadata
        ) VALUES (
          'reject-dpop-metadata', 'reject-dpop-metadata',
          ARRAY['https://client.example/callback'], 'none', 'web',
          '{"dpop_bound_access_tokens":true}'::jsonb
        )
      `),
      "reject-dpop-metadata",
    );

    await client.exec(`
      UPDATE oauth_client
      SET reference_id = 'org_fixed'
      WHERE client_id = 'insert-modern';

      INSERT INTO "user" (id, name, email, email_verified)
      VALUES ('rollback-user', 'Rollback User', 'rollback@example.com', true);

      INSERT INTO oauth_access_token (
        id, token, client_id, scopes, confirmation
      ) VALUES ('guard-access', 'guard-access-token', 'insert-modern', ARRAY['mcp:read'], NULL);

      INSERT INTO oauth_refresh_token (
        id, token, client_id, user_id, scopes, confirmation
      ) VALUES (
        'guard-refresh', 'guard-refresh-token', 'insert-modern',
        'rollback-user', ARRAY['mcp:read'], NULL
      );

      INSERT INTO verification (id, identifier, value, expires_at)
      VALUES (
        'guard-verification', 'guard-code',
        '{"type":"authorization_code","query":{"client_id":"insert-modern"}}',
        now() + interval '10 minutes'
      );
    `);

    const boundTokenResources = await client.query<{
      access_reference_id: string;
      access_resources: string[];
      refresh_reference_id: string;
      refresh_resources: string[];
    }>(`
      SELECT
        (SELECT reference_id FROM oauth_access_token WHERE id = 'guard-access')
          AS access_reference_id,
        (SELECT resources FROM oauth_access_token WHERE id = 'guard-access')
          AS access_resources,
        (SELECT reference_id FROM oauth_refresh_token WHERE id = 'guard-refresh')
          AS refresh_reference_id,
        (SELECT resources FROM oauth_refresh_token WHERE id = 'guard-refresh')
          AS refresh_resources
    `);
    expect(boundTokenResources.rows).toEqual([
      {
        access_reference_id: "org_fixed",
        access_resources: ["https://guard.example/mcp"],
        refresh_reference_id: "org_fixed",
        refresh_resources: ["https://guard.example/mcp"],
      },
    ]);

    await expectCheckFailure(
      client.exec(`
        INSERT INTO oauth_access_token (
          id, token, client_id, scopes, resources
        ) VALUES (
          'guard-access-noncanonical', 'guard-access-noncanonical-token',
          'insert-modern', ARRAY['mcp:read'], ARRAY['https://other.example/mcp']
        )
      `),
      "guard-access-noncanonical",
    );

    await expectCheckFailure(
      client.exec(`
        INSERT INTO oauth_access_token (id, token, client_id, scopes)
        VALUES (
          'guard-access-unlinked', 'guard-access-unlinked-token',
          'insert-modern-confidential', ARRAY['mcp:read']
        )
      `),
      "guard-access-unlinked",
    );

    for (const [recordId, statement] of [
      [
        "guard-resource",
        `UPDATE oauth_resource
         SET dpop_bound_access_tokens_required = true
         WHERE id = 'guard-resource'`,
      ],
      [
        "guard-access",
        `UPDATE oauth_access_token
         SET confirmation = '{"jkt":"thumbprint"}'::jsonb
         WHERE id = 'guard-access'`,
      ],
      [
        "guard-refresh",
        `UPDATE oauth_refresh_token
         SET confirmation = '{"jkt":"thumbprint"}'::jsonb
         WHERE id = 'guard-refresh'`,
      ],
      [
        "guard-verification",
        `UPDATE verification
         SET value = '{"type":"authorization_code","query":{"client_id":"insert-modern","dpop_jkt":"thumbprint"}}'
         WHERE id = 'guard-verification'`,
      ],
    ] as const) {
      await expectCheckFailure(client.exec(statement), recordId);
    }

    const rejectedCount = await client.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM oauth_client
      WHERE client_id LIKE 'reject-%'
    `);
    expect(rejectedCount.rows).toEqual([{ count: 0 }]);
  }, 30_000);

  it("rolls back failed preflight atomically and identifies every incompatible state", async () => {
    const client = await migrateThrough0058();
    await client.exec(`
      INSERT INTO oauth_client (
        id, client_id, redirect_uris,
        token_endpoint_auth_method, application_type, public, type
      ) VALUES
        ('invalid', 'preflight-invalid', ARRAY['https://client.example/callback'], 'private_key_jwt', 'web', NULL, NULL),
        ('valid', 'preflight-valid', ARRAY['https://client.example/callback'], 'none', 'web', NULL, NULL)
      ;
      INSERT INTO oauth_resource (
        id, identifier, name, dpop_bound_access_tokens_required, disabled
      ) VALUES (
        'canonical-resource', 'https://canonical.example/mcp',
        'Canonical', false, false
      );
      INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at)
      SELECT 'preflight-link-' || id, client_id,
             'https://canonical.example/mcp', now()
      FROM oauth_client;
    `);

    await client.exec(`
      UPDATE oauth_client
      SET dpop_bound_access_tokens = true
      WHERE client_id = 'preflight-invalid'
    `);

    await client.exec(`
      INSERT INTO "user" (id, name, email, email_verified)
      VALUES ('preflight-user', 'Preflight User', 'preflight@example.com', true);

      INSERT INTO oauth_access_token (
        id, token, client_id, scopes, confirmation
      ) VALUES (
        'preflight-access', 'preflight-access-token', 'preflight-valid',
        ARRAY['mcp:read'], '{"jkt":"thumbprint"}'::jsonb
      );
    `);

    await expectCheckFailure(client.exec(bridgeMigration), "preflight-access");
    const installationAfterFailure = await client.query<{
      trigger_count: number;
      function_name: string | null;
    }>(`
      SELECT
        (SELECT count(*)::int FROM pg_trigger
          WHERE tgname = 'oauth_client_rollback_bridge'
            AND NOT tgisinternal) AS trigger_count,
        to_regprocedure('public.sync_oauth_client_rollback_fields()')::text
          AS function_name
    `);
    expect(installationAfterFailure.rows).toEqual([
      { trigger_count: 0, function_name: null },
    ]);
    expect(
      (await compatibilityRows(client)).find(
        ({ client_id }) => client_id === "preflight-valid",
      ),
    ).toEqual({
      client_id: "preflight-valid",
      token_endpoint_auth_method: "none",
      application_type: "web",
      public: null,
      type: null,
    });

    await client.exec(`
      UPDATE oauth_access_token
      SET confirmation = NULL
      WHERE id = 'preflight-access'
    `);
    await expectCheckFailure(client.exec(bridgeMigration), "preflight-invalid");

    await client.exec(`
      UPDATE oauth_client
      SET token_endpoint_auth_method = 'none', application_type = 'web',
          public = false, type = 'web'
      WHERE client_id = 'preflight-invalid'
    `);
    await expectCheckFailure(client.exec(bridgeMigration), "preflight-invalid");

    await client.exec(`
      UPDATE oauth_client
      SET token_endpoint_auth_method = 'client_secret_basic',
          application_type = 'native', public = false, type = NULL,
          dpop_bound_access_tokens = false
      WHERE client_id = 'preflight-invalid'
    `);
    await expectCheckFailure(client.exec(bridgeMigration), "preflight-invalid");

    await client.exec(`
      UPDATE oauth_client
      SET token_endpoint_auth_method = 'client_secret_basic',
          application_type = 'web', public = NULL, type = NULL
      WHERE client_id = 'preflight-invalid'
    `);

    await client.exec(`
      INSERT INTO oauth_resource (
        id, identifier, name, dpop_bound_access_tokens_required, disabled
      ) VALUES (
        'preflight-resource', 'https://preflight.example/mcp',
        'Preflight', true, true
      );

      INSERT INTO oauth_refresh_token (
        id, token, client_id, user_id, scopes, confirmation
      ) VALUES (
        'preflight-refresh', 'preflight-refresh-token', 'preflight-valid',
        'preflight-user', ARRAY['mcp:read'], '{"jkt":"thumbprint"}'::jsonb
      );

      INSERT INTO verification (id, identifier, value, expires_at)
      VALUES (
        'preflight-verification', 'preflight-code',
        '{"type":"authorization_code","query":{"client_id":"preflight-valid","dpop_jkt":"thumbprint"}}',
        now() + interval '10 minutes'
      );
    `);

    await expectCheckFailure(client.exec(bridgeMigration), "preflight-refresh");
    await client.exec(`
      UPDATE oauth_refresh_token
      SET confirmation = NULL
      WHERE id = 'preflight-refresh'
    `);

    await expectCheckFailure(
      client.exec(bridgeMigration),
      "https://preflight.example/mcp",
    );
    await client.exec(`
      UPDATE oauth_resource
      SET dpop_bound_access_tokens_required = false
      WHERE id = 'preflight-resource'
    `);

    await expectCheckFailure(client.exec(bridgeMigration), "preflight-verification");
    await client.exec(`
      UPDATE verification
      SET value = '{"type":"authorization_code","query":{"client_id":"preflight-valid"}}'
      WHERE id = 'preflight-verification'
    `);

    await client.exec(bridgeMigration);

    expect(
      (await compatibilityRows(client)).filter(({ client_id }) =>
        client_id.startsWith("preflight-"),
      ),
    ).toEqual([
      { client_id: "preflight-invalid", token_endpoint_auth_method: "client_secret_basic", application_type: "web", public: false, type: "web" },
      { client_id: "preflight-valid", token_endpoint_auth_method: "none", application_type: "web", public: true, type: "user-agent-based" },
    ]);
    const preservedLegacyToken = await client.query<{ resources: string[] | null }>(`
      SELECT resources
      FROM oauth_access_token
      WHERE id = 'preflight-access'
    `);
    expect(preservedLegacyToken.rows).toEqual([{ resources: null }]);
  }, 30_000);

  it("links clients created by a rolled-back 1.6 runtime and canonicalizes their tokens", async () => {
    const client = await migrateThrough0058();
    await client.exec(bridgeMigration);

    await client.exec(`
      INSERT INTO oauth_client (
        id, client_id, redirect_uris, scopes, reference_id, public, type
      ) VALUES (
        'legacy-before-resource', 'legacy-before-resource',
        ARRAY['http://127.0.0.1/callback'], ARRAY['mcp:read'],
        'org_fixed', true, 'native'
      )
    `);
    const beforeResource = await client.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM oauth_client_resource
    `);
    expect(beforeResource.rows).toEqual([{ count: 0 }]);

    await client.exec(`
      INSERT INTO oauth_resource (id, identifier, name, disabled)
      VALUES (
        'rollback-canonical', 'https://worker.example/mcp',
        'Rollback canonical', false
      );
      INSERT INTO oauth_client (
        id, client_id, redirect_uris, scopes, reference_id, public, type
      ) VALUES (
        'legacy-after-resource', 'legacy-after-resource',
        ARRAY['http://127.0.0.1/callback'], ARRAY['mcp:read'],
        'org_fixed', true, 'native'
      );
      INSERT INTO oauth_access_token (id, token, client_id, scopes)
      VALUES (
        'legacy-new-access', 'legacy-new-access-token',
        'legacy-after-resource', ARRAY['mcp:read']
      )
    `);

    const linked = await client.query<{
      client_id: string;
      resource_id: string;
    }>(`
      SELECT client_id, resource_id
      FROM oauth_client_resource
      ORDER BY client_id
    `);
    expect(linked.rows).toEqual([
      {
        client_id: "legacy-after-resource",
        resource_id: "https://worker.example/mcp",
      },
      {
        client_id: "legacy-before-resource",
        resource_id: "https://worker.example/mcp",
      },
    ]);
    const token = await client.query<{
      reference_id: string;
      resources: string[];
    }>(`
      SELECT reference_id, resources
      FROM oauth_access_token
      WHERE id = 'legacy-new-access'
    `);
    expect(token.rows).toEqual([
      {
        reference_id: "org_fixed",
        resources: ["https://worker.example/mcp"],
      },
    ]);

    await expectCheckFailure(
      client.exec(`
        INSERT INTO oauth_resource (id, identifier, name, disabled)
        VALUES (
          'rollback-second', 'https://second.example/mcp',
          'Rollback second', false
        )
      `),
      "https://second.example/mcp",
    );
  }, 30_000);

  it("rejects multiple enabled resources before the first client exists", async () => {
    const client = await migrateThrough0058();
    await client.exec(`
      INSERT INTO oauth_resource (id, identifier, name, disabled) VALUES
        ('first-resource', 'https://first.example/mcp', 'First', false),
        ('second-resource', 'https://second.example/mcp', 'Second', false)
    `);

    await expectCheckFailure(client.exec(bridgeMigration), "found 2");
    const installationAfterFailure = await client.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM pg_trigger
      WHERE tgname = 'oauth_client_rollback_bridge'
        AND NOT tgisinternal
    `);
    expect(installationAfterFailure.rows).toEqual([{ count: 0 }]);
  }, 30_000);
});
