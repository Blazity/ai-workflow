import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatPrepareMcpOauthResourcesResult,
  parsePrepareMcpOauthResourcesArguments,
  prepareMcpOauthResources,
  resolvePrepareMcpOauthResourcesDeployment,
  runPrepareMcpOauthResourcesCli,
  type PrepareMcpOauthResourcesOptions,
} from "../../scripts/prepare-mcp-oauth-resources.js";
import { createAuth } from "../auth.js";
import type { Db } from "./client.js";
import * as schema from "./schema.js";

const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));
const databaseUrl =
  "postgresql://operator:secret@ep-aiw330-pooler.example.neon.tech/worker";
const betterAuthUrl = "https://worker.example.com/";
const canonicalResource = "https://worker.example.com/mcp";
const endpointHost = "ep-aiw330.example.neon.tech";
const openClients: PGlite[] = [];

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

async function migrateThrough(lastPrefix = "0058"): Promise<{
  client: PGlite;
  db: Db;
}> {
  const client = new PGlite();
  openClients.push(client);
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql") && file.slice(0, 4) <= lastPrefix)
    .sort();
  for (const file of files) {
    await client.exec(readFileSync(`${migrationsDir}${file}`, "utf8"));
  }
  await client.exec(`
    INSERT INTO env_marker (id, env, endpoint_host)
    VALUES (1, 'preview', '${endpointHost}')
  `);
  return {
    client,
    db: drizzle({ client, schema }) as unknown as Db,
  };
}

function options(
  apply: boolean,
  confirmSingleAudienceHistory = false,
): PrepareMcpOauthResourcesOptions {
  return parsePrepareMcpOauthResourcesArguments([
    ...(apply ? ["--apply"] : []),
    ...(confirmSingleAudienceHistory
      ? ["--confirm-single-audience-history"]
      : []),
    "--target-environment",
    "preview",
  ]);
}

function deployment() {
  return resolvePrepareMcpOauthResourcesDeployment(options(false), {
    DATABASE_URL: databaseUrl,
    BETTER_AUTH_URL: betterAuthUrl,
  });
}

async function seedCompatibleLegacyRows(client: PGlite): Promise<void> {
  await client.exec(`
    INSERT INTO "user" (id, name, email, email_verified)
    VALUES ('fixture-user', 'Fixture User', 'fixture@example.com', true);
    INSERT INTO oauth_client (id, client_id, redirect_uris, scopes, metadata) VALUES
      ('client-row-a', 'client-a', ARRAY['https://client-a.example/callback'], ARRAY['mcp:read'], '{"owner":"fixture"}'::jsonb),
      ('client-row-b', 'client-b', ARRAY['https://client-b.example/callback'], ARRAY['mcp:read'], NULL);
    INSERT INTO oauth_refresh_token (
      id, token, client_id, user_id, scopes, expires_at
    ) VALUES (
      'refresh-row', 'refresh-secret-must-not-be-printed', 'client-a',
      'fixture-user', ARRAY['mcp:read', 'offline_access'], now() + interval '1 day'
    );
    INSERT INTO oauth_access_token (
      id, token, client_id, user_id, scopes, expires_at
    ) VALUES (
      'access-row', 'access-secret-must-not-be-printed', 'client-a',
      'fixture-user', ARRAY['mcp:read'], now() + interval '1 hour'
    );
    INSERT INTO oauth_consent (id, client_id, user_id, scopes, resources)
    VALUES (
      'consent-row', 'client-a', 'fixture-user',
      ARRAY['mcp:read', 'offline_access'], NULL
    );
  `);
}

async function oauthState(client: PGlite) {
  const result = await client.query<{
    resources: number;
    links: number;
    consent_resources: string[] | null;
    consent_scopes: string[];
    refresh_resources: string[] | null;
    refresh_scopes: string[];
    refresh_token: string;
    access_resources: string[] | null;
    access_scopes: string[];
    access_token: string;
    client_scopes: string[];
    client_metadata: { owner: string };
  }>(`
    SELECT
      (SELECT count(*)::int FROM oauth_resource) AS resources,
      (SELECT count(*)::int FROM oauth_client_resource) AS links,
      (SELECT resources FROM oauth_consent WHERE id = 'consent-row') AS consent_resources,
      (SELECT scopes FROM oauth_consent WHERE id = 'consent-row') AS consent_scopes,
      (SELECT resources FROM oauth_refresh_token WHERE id = 'refresh-row') AS refresh_resources,
      (SELECT scopes FROM oauth_refresh_token WHERE id = 'refresh-row') AS refresh_scopes,
      (SELECT token FROM oauth_refresh_token WHERE id = 'refresh-row') AS refresh_token,
      (SELECT resources FROM oauth_access_token WHERE id = 'access-row') AS access_resources,
      (SELECT scopes FROM oauth_access_token WHERE id = 'access-row') AS access_scopes,
      (SELECT token FROM oauth_access_token WHERE id = 'access-row') AS access_token,
      (SELECT scopes FROM oauth_client WHERE client_id = 'client-a') AS client_scopes,
      (SELECT metadata FROM oauth_client WHERE client_id = 'client-a') AS client_metadata
  `);
  return result.rows[0];
}

describe("prepare-mcp-oauth-resources", () => {
  it("parses only the explicit safe CLI contract", () => {
    expect(
      parsePrepareMcpOauthResourcesArguments([
        "--target-environment",
        "preview",
      ]),
    ).toEqual({
      apply: false,
      confirmProduction: false,
      confirmSingleAudienceHistory: false,
      targetEnvironment: "preview",
    });
    expect(() => parsePrepareMcpOauthResourcesArguments([])).toThrow(
      "--target-environment",
    );
    expect(() =>
      parsePrepareMcpOauthResourcesArguments(["--target-environment"]),
    ).toThrow("Missing value");
    expect(() =>
      parsePrepareMcpOauthResourcesArguments([
        "--target-environment",
        "preview",
        "--target-environment",
        "staging",
      ]),
    ).toThrow("Duplicate flag");
    expect(() =>
      parsePrepareMcpOauthResourcesArguments([
        "--target-environment",
        "preview",
        "--apply",
        "--apply",
      ]),
    ).toThrow("Duplicate flag");
    expect(() =>
      parsePrepareMcpOauthResourcesArguments([
        "--target-environment",
        "preview",
        "--surprise",
      ]),
    ).toThrow("Unknown flag");
    expect(() =>
      parsePrepareMcpOauthResourcesArguments([
        "--apply",
        "--target-environment",
        "production",
      ]),
    ).toThrow("--confirm-production");
    expect(() =>
      parsePrepareMcpOauthResourcesArguments([
        "--apply",
        "--confirm-production",
        "--target-environment",
        "production",
      ]),
    ).not.toThrow();
  });

  it("requires explicit deployment URLs and normalizes the database hostname", () => {
    expect(() =>
      resolvePrepareMcpOauthResourcesDeployment(options(false), {}),
    ).toThrow("DATABASE_URL");
    expect(() =>
      resolvePrepareMcpOauthResourcesDeployment(options(false), {
        DATABASE_URL: databaseUrl,
      }),
    ).toThrow("BETTER_AUTH_URL");
    expect(() =>
      resolvePrepareMcpOauthResourcesDeployment(options(false), {
        DATABASE_URL: databaseUrl,
        BETTER_AUTH_URL: "https://user:password@worker.example.com",
      }),
    ).toThrow("without credentials");
    expect(() =>
      resolvePrepareMcpOauthResourcesDeployment(options(true), {
        DATABASE_URL: databaseUrl,
        BETTER_AUTH_URL: betterAuthUrl,
        VERCEL_ENV: "production",
      }),
    ).toThrow("--confirm-production");
    expect(deployment()).toMatchObject({
      canonicalResource,
      endpointHost,
      targetEnvironment: "preview",
    });
  });

  it("fails before planning when migration 0058 or the exact environment marker is absent", async () => {
    const beforeExpand = await migrateThrough("0057");
    await expect(
      prepareMcpOauthResources(
        beforeExpand.db,
        deployment(),
        options(false),
      ),
    ).rejects.toThrow("migration 0058 is incomplete");

    const migrated = await migrateThrough();
    await migrated.client.exec(
      "UPDATE env_marker SET env = 'staging' WHERE id = 1",
    );
    await expect(
      prepareMcpOauthResources(migrated.db, deployment(), options(false)),
    ).rejects.toThrow("environment mismatch");
    await migrated.client.exec(`
      UPDATE env_marker
      SET env = 'preview', endpoint_host = 'other.example.neon.tech'
      WHERE id = 1
    `);
    await expect(
      prepareMcpOauthResources(migrated.db, deployment(), options(false)),
    ).rejects.toThrow("endpoint mismatch");
  }, 30_000);

  it("keeps dry-run read-only, reports counts only, and closes an injected connection", async () => {
    const migrated = await migrateThrough();
    await seedCompatibleLegacyRows(migrated.client);
    const close = vi.fn(async () => undefined);
    const output: string[] = [];

    await runPrepareMcpOauthResourcesCli(
      ["--target-environment", "preview"],
      {
        environment: {
          DATABASE_URL: databaseUrl,
          BETTER_AUTH_URL: betterAuthUrl,
        },
        openDatabase: async () => ({ db: migrated.db, close }),
        write: (text) => output.push(text),
      },
    );

    expect(close).toHaveBeenCalledOnce();
    expect(await oauthState(migrated.client)).toMatchObject({
      resources: 0,
      links: 0,
      consent_resources: null,
      refresh_resources: null,
      access_resources: null,
    });
    expect(output.join(""))
      .toContain("planned mutations: resources=1 links=2 consents=1");
    expect(output.join(""))
      .toContain("consent history confirmation required: yes");
    expect(output.join("")).toContain("AIW-331 handoff");
    expect(output.join("")).not.toContain("refresh-secret");
    expect(output.join("")).not.toContain("access-secret");
    expect(output.join("")).not.toContain("operator:secret");
  }, 30_000);

  it("requires explicit single-audience history before consent backfill", async () => {
    const migrated = await migrateThrough();
    await seedCompatibleLegacyRows(migrated.client);

    await expect(
      prepareMcpOauthResources(migrated.db, deployment(), options(true)),
    ).rejects.toThrow("--confirm-single-audience-history");
    expect(await oauthState(migrated.client)).toMatchObject({
      resources: 0,
      links: 0,
      consent_resources: null,
    });
  }, 30_000);

  it("applies atomically, preserves tokens and scopes, and retries with zero mutations", async () => {
    const migrated = await migrateThrough();
    await seedCompatibleLegacyRows(migrated.client);

    const first = await prepareMcpOauthResources(
      migrated.db,
      deployment(),
      options(true, true),
    );
    const second = await prepareMcpOauthResources(
      migrated.db,
      deployment(),
      options(true),
    );

    expect(first.applied).toEqual({ resources: 1, clientLinks: 2, consents: 1 });
    expect(first.singleAudienceHistoryConfirmed).toBe(true);
    expect(second.applied).toEqual({ resources: 0, clientLinks: 0, consents: 0 });
    expect(await oauthState(migrated.client)).toMatchObject({
      resources: 1,
      links: 2,
      consent_resources: [canonicalResource],
      consent_scopes: ["mcp:read", "offline_access"],
      refresh_resources: null,
      refresh_scopes: ["mcp:read", "offline_access"],
      refresh_token: "refresh-secret-must-not-be-printed",
      access_resources: null,
      access_scopes: ["mcp:read"],
      access_token: "access-secret-must-not-be-printed",
      client_scopes: ["mcp:read"],
      client_metadata: { owner: "fixture" },
    });
    const resource = await migrated.client.query<{
      name: string;
      access_token_ttl: number | null;
      refresh_token_ttl: number | null;
      signing_algorithm: string | null;
      signing_key_id: string | null;
      allowed_scopes: string[] | null;
      custom_claims: unknown | null;
      dpop_bound_access_tokens_required: boolean;
      disabled: boolean;
      policy_version: number;
    }>(`
      SELECT name, access_token_ttl, refresh_token_ttl, signing_algorithm,
             signing_key_id, allowed_scopes, custom_claims,
             dpop_bound_access_tokens_required, disabled, policy_version
      FROM oauth_resource
    `);
    expect(resource.rows).toEqual([
      {
        name: canonicalResource,
        access_token_ttl: null,
        refresh_token_ttl: null,
        signing_algorithm: null,
        signing_key_id: null,
        allowed_scopes: null,
        custom_claims: null,
        dpop_bound_access_tokens_required: false,
        disabled: false,
        policy_version: 1,
      },
    ]);
  }, 30_000);

  it("accepts already canonical resource-bound grants without rewriting them", async () => {
    const migrated = await migrateThrough();
    await seedCompatibleLegacyRows(migrated.client);
    await migrated.client.exec(`
      INSERT INTO oauth_resource (
        id, identifier, name, allowed_scopes,
        dpop_bound_access_tokens_required, disabled, policy_version
      ) VALUES (
        'canonical-row', '${canonicalResource}', '${canonicalResource}', NULL,
        false, false, 1
      );
      UPDATE oauth_refresh_token SET resources = ARRAY['${canonicalResource}'];
      UPDATE oauth_access_token SET resources = ARRAY['${canonicalResource}'];
      UPDATE oauth_consent SET resources = ARRAY['${canonicalResource}'];
    `);

    const result = await prepareMcpOauthResources(
      migrated.db,
      deployment(),
      options(true),
    );

    expect(result.applied).toEqual({ resources: 0, clientLinks: 2, consents: 0 });
    expect(await oauthState(migrated.client)).toMatchObject({
      refresh_resources: [canonicalResource],
      access_resources: [canonicalResource],
      consent_resources: [canonicalResource],
    });
  }, 30_000);

  it("rejects noncanonical policy, links, grants, scopes, and active refresh anomalies", async () => {
    const cases: Array<{
      mutate: (client: PGlite) => Promise<unknown>;
      message: RegExp;
    }> = [
      {
        mutate: (client) =>
          client.exec(`
            INSERT INTO oauth_resource (id, identifier, name)
            VALUES ('foreign-resource', 'https://other.example/mcp', 'foreign')
          `),
        message: /noncanonical oauth_resource rows/,
      },
      {
        mutate: (client) =>
          client.exec(`
            INSERT INTO oauth_resource (
              id, identifier, name, access_token_ttl,
              dpop_bound_access_tokens_required, disabled, policy_version
            ) VALUES (
              'policy-resource', '${canonicalResource}', '${canonicalResource}',
              60, false, false, 1
            )
          `),
        message: /incompatible canonical oauth_resource policy/,
      },
      {
        mutate: (client) =>
          client.exec(`
            INSERT INTO oauth_resource (
              id, identifier, name, custom_claims,
              dpop_bound_access_tokens_required, disabled, policy_version
            ) VALUES (
              'json-null-policy-resource', '${canonicalResource}',
              '${canonicalResource}', 'null'::jsonb, false, false, 1
            )
          `),
        message: /incompatible canonical oauth_resource policy/,
      },
      {
        mutate: (client) =>
          client.exec(
            "UPDATE oauth_access_token SET resources = ARRAY['https://other.example/mcp']",
          ),
        message: /incompatible oauth_access_token resources/,
      },
      {
        mutate: (client) =>
          client.exec("UPDATE oauth_refresh_token SET resources = '{}'::text[]"),
        message: /incompatible oauth_refresh_token resources/,
      },
      {
        mutate: (client) =>
          client.exec("UPDATE oauth_refresh_token SET scopes = ARRAY['mcp:read']"),
        message: /without offline_access/,
      },
      {
        mutate: (client) =>
          client.exec(
            "UPDATE oauth_refresh_token SET scopes = ARRAY[NULL]::text[]",
          ),
        message: /without offline_access/,
      },
      {
        mutate: (client) =>
          client.exec("UPDATE oauth_consent SET scopes = ARRAY['admin:everything']"),
        message: /unsupported scopes/,
      },
      {
        mutate: (client) =>
          client.exec("UPDATE oauth_consent SET scopes = ARRAY[NULL]::text[]"),
        message: /unsupported scopes/,
      },
      {
        mutate: (client) =>
          client.exec(
            "UPDATE oauth_consent SET resources = ARRAY['https://other.example/mcp']",
          ),
        message: /incompatible resources/,
      },
      {
        mutate: (client) =>
          client.exec(`
            INSERT INTO oauth_resource (id, identifier, name)
            VALUES ('linked-foreign', 'https://other.example/mcp', 'foreign');
            INSERT INTO oauth_client_resource (id, client_id, resource_id)
            VALUES ('foreign-link', 'client-a', 'https://other.example/mcp')
          `),
        message: /noncanonical oauth_client_resource rows/,
      },
      {
        mutate: async (client) => {
          await client.exec(`
            INSERT INTO oauth_resource (
              id, identifier, name, dpop_bound_access_tokens_required,
              disabled, policy_version
            ) VALUES (
              'orphan-canonical', '${canonicalResource}', '${canonicalResource}',
              false, false, 1
            );
            ALTER TABLE oauth_client_resource DROP CONSTRAINT
              oauth_client_resource_client_id_oauth_client_client_id_fk;
            INSERT INTO oauth_client_resource (id, client_id, resource_id)
            VALUES ('orphan-link', 'missing-client', '${canonicalResource}')
          `);
        },
        message: /orphan oauth_client_resource rows/,
      },
      {
        mutate: async (client) => {
          await client.exec(`
            ALTER TABLE oauth_consent DROP CONSTRAINT
              oauth_consent_client_id_oauth_client_client_id_fk;
            INSERT INTO oauth_consent (id, client_id, scopes, resources)
            VALUES ('orphan-consent', 'missing-client', ARRAY['mcp:read'], NULL)
          `);
        },
        message: /orphan oauth_consent rows/,
      },
    ];

    for (const testCase of cases) {
      const migrated = await migrateThrough();
      await seedCompatibleLegacyRows(migrated.client);
      await testCase.mutate(migrated.client);
      await expect(
        prepareMcpOauthResources(migrated.db, deployment(), options(false)),
      ).rejects.toThrow(testCase.message);
    }
  }, 60_000);

  it("rolls every write back when a post-write check fails", async () => {
    const migrated = await migrateThrough();
    await seedCompatibleLegacyRows(migrated.client);

    await expect(
      prepareMcpOauthResources(
        migrated.db,
        deployment(),
        options(true, true),
        {
          afterWrites: async () => {
            throw new Error("forced post-write failure");
          },
        },
      ),
    ).rejects.toThrow("forced post-write failure");
    expect(await oauthState(migrated.client)).toMatchObject({
      resources: 0,
      links: 0,
      consent_resources: null,
      refresh_resources: null,
      access_resources: null,
    });
  }, 30_000);

  it("links a client created by the installed Better Auth 1.6 DCR handler", async () => {
    const migrated = await migrateThrough();
    await migrated.client.exec(`
      INSERT INTO organization (id, name, slug)
      VALUES ('dcr-org', 'DCR Organization', 'dcr-organization')
    `);
    const auth = createAuth(migrated.db, {
      secret: "x".repeat(32),
      baseURL: "https://worker.example.com",
      trustedOrigins: ["https://worker.example.com"],
      mcp: { organizationId: "dcr-org", allowPublicDcr: true },
    });
    const response = await auth.handler(
      new Request("https://worker.example.com/api/auth/oauth2/register", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://worker.example.com",
        },
        body: JSON.stringify({
          client_name: "AIW-330 DCR Client",
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          redirect_uris: ["http://127.0.0.1:43110/callback"],
          scope: "mcp:read runs:dispatch",
        }),
      }),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const registered = (await response.json()) as { client_id: string };

    const result = await prepareMcpOauthResources(
      migrated.db,
      deployment(),
      options(true),
    );
    expect(result.applied.clientLinks).toBe(1);
    const links = await migrated.client.query<{
      count: number;
      resource_id: string;
    }>(`
      SELECT count(*)::int AS count, min(resource_id) AS resource_id
      FROM oauth_client_resource
      WHERE client_id = $1
    `, [registered.client_id]);
    expect(links.rows).toEqual([{ count: 1, resource_id: canonicalResource }]);
  }, 30_000);

  it("reconciles existing DCR-like clients and catches a client inserted after a run", async () => {
    const migrated = await migrateThrough();
    await migrated.client.exec(`
      INSERT INTO oauth_client (id, client_id, redirect_uris, scopes)
      VALUES (
        'dcr-existing-row', 'dcr-existing',
        ARRAY['https://dcr-existing.example/callback'], ARRAY['mcp:read']
      )
    `);

    const first = await prepareMcpOauthResources(
      migrated.db,
      deployment(),
      options(true),
    );
    expect(first.applied.clientLinks).toBe(1);

    await migrated.client.exec(`
      INSERT INTO oauth_client (id, client_id, redirect_uris, scopes)
      VALUES (
        'dcr-later-row', 'dcr-later',
        ARRAY['https://dcr-later.example/callback'], ARRAY['mcp:read']
      )
    `);
    const dryRun = await prepareMcpOauthResources(
      migrated.db,
      deployment(),
      options(false),
    );
    expect(dryRun.planned).toEqual({ resources: 0, clientLinks: 1, consents: 0 });
    expect(formatPrepareMcpOauthResourcesResult(dryRun)).toContain(
      "AIW-331 handoff",
    );

    const second = await prepareMcpOauthResources(
      migrated.db,
      deployment(),
      options(true),
    );
    expect(second.applied).toEqual({ resources: 0, clientLinks: 1, consents: 0 });
    const links = await migrated.client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM oauth_client_resource",
    );
    expect(links.rows).toEqual([{ count: 2 }]);
  }, 30_000);
});
