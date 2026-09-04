import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((...args: unknown[]) => {
    const result = Reflect.apply(
      actual.readFileSync as (...values: unknown[]) => unknown,
      actual,
      args,
    );

    // This suite exercises the one-shot preparation while the source runtime
    // is still 1.6.30. Post-switch refusal on the real 1.7.2 runtime is covered
    // explicitly below and must remain fail-closed.
    if (
      typeof result === "string" &&
      String(args[0]).endsWith("/apps/worker/package.json")
    ) {
      const packageJson = JSON.parse(result) as {
        dependencies?: Record<string, string>;
      };
      if (packageJson.dependencies) {
        packageJson.dependencies["@better-auth/oauth-provider"] = "1.6.30";
      }
      return `${JSON.stringify(packageJson, null, 2)}\n`;
    }

    return result;
  }) as typeof actual.readFileSync;

  return { ...actual, readFileSync };
});

import {
  parsePrepareMcpServiceClientScopesArguments,
  prepareMcpServiceClientScopes,
  resolvePrepareMcpServiceClientScopesDeployment,
  runPrepareMcpServiceClientScopesCli,
  type PrepareMcpServiceClientScopesOptions,
} from "../../scripts/prepare-mcp-service-client-scopes.js";
import type { Db } from "./client.js";
import * as schema from "./schema.js";

const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));
const databaseUrl =
  "postgresql://operator:secret@ep-aiw334-pooler.example.neon.tech/worker";
const endpointHost = "ep-aiw334.example.neon.tech";
const organizationSlug = "ai-workflow";
const organizationId = "org-service";
const openClients: PGlite[] = [];
let clientSequence = 0;

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
    VALUES (1, 'preview', '${endpointHost}');
    INSERT INTO organization (id, name, slug)
    VALUES ('${organizationId}', 'Service Organization', '${organizationSlug}');
  `);
  return {
    client,
    db: drizzle({ client, schema }) as unknown as Db,
  };
}

function options(apply: boolean): PrepareMcpServiceClientScopesOptions {
  return parsePrepareMcpServiceClientScopesArguments([
    ...(apply ? ["--apply", "--confirm-legacy-runtime-1-6"] : []),
    "--target-environment",
    "preview",
    "--organization-slug",
    organizationSlug,
  ]);
}

function deployment(apply = false) {
  return resolvePrepareMcpServiceClientScopesDeployment(options(apply), {
    DATABASE_URL: databaseUrl,
    DASHBOARD_ORG_SLUG: organizationSlug,
  });
}

type ClientInsert = typeof schema.oauthClient.$inferInsert;

async function seedClient(
  db: Db,
  overrides: Partial<ClientInsert> = {},
): Promise<ClientInsert> {
  clientSequence += 1;
  const id = `service-row-${clientSequence}`;
  const value: ClientInsert = {
    id,
    clientId: `service-client-${clientSequence}`,
    clientSecret: `secret-${clientSequence}`,
    disabled: false,
    scopes: ["mcp:read", "prompts:write", "mcp:read"],
    clientCredentialsScopes: [],
    userId: null,
    createdAt: new Date("2026-08-27T10:00:00.000Z"),
    updatedAt: new Date("2026-08-27T11:00:00.000Z"),
    name: "Service client",
    redirectUris: ["https://required-by-legacy.example/callback"],
    tokenEndpointAuthMethod: "client_secret_basic",
    applicationType: null,
    grantTypes: ["client_credentials"],
    public: false,
    type: "web",
    referenceId: organizationId,
    metadata: { fixture: true },
    ...overrides,
  };
  await db.insert(schema.oauthClient).values(value);
  return value;
}

async function credentialsState(client: PGlite) {
  const result = await client.query<{
    client_id: string;
    client_credentials_scopes: string[] | null;
    protected: Record<string, unknown>;
  }>(`
    SELECT
      client_id,
      client_credentials_scopes,
      to_jsonb(oauth_client) - 'client_credentials_scopes' AS protected
    FROM oauth_client
    ORDER BY id
  `);
  return result.rows;
}

describe("prepare-mcp-service-client-scopes", () => {
  it("parses only the explicit safe CLI contract", () => {
    expect(
      parsePrepareMcpServiceClientScopesArguments([
        "--target-environment",
        "preview",
        "--organization-slug",
        organizationSlug,
      ]),
    ).toEqual({
      apply: false,
      confirmLegacyRuntime16: false,
      confirmProduction: false,
      organizationSlug,
      targetEnvironment: "preview",
    });
    expect(() => parsePrepareMcpServiceClientScopesArguments([])).toThrow(
      "--target-environment",
    );
    expect(() =>
      parsePrepareMcpServiceClientScopesArguments([
        "--target-environment",
        "preview",
      ]),
    ).toThrow("--organization-slug");
    expect(() =>
      parsePrepareMcpServiceClientScopesArguments([
        "--apply",
        "--target-environment",
        "preview",
        "--organization-slug",
        organizationSlug,
      ]),
    ).toThrow("--confirm-legacy-runtime-1-6");
    expect(() =>
      parsePrepareMcpServiceClientScopesArguments([
        "--apply",
        "--confirm-legacy-runtime-1-6",
        "--target-environment",
        "production",
        "--organization-slug",
        organizationSlug,
      ]),
    ).toThrow("--confirm-production");
    expect(() =>
      parsePrepareMcpServiceClientScopesArguments([
        "--apply",
        "--confirm-legacy-runtime-1-6",
        "--target-environment",
        "Production",
        "--organization-slug",
        organizationSlug,
      ]),
    ).toThrow("--confirm-production");
    expect(() =>
      parsePrepareMcpServiceClientScopesArguments([
        "--target-environment",
        "preview",
        "--organization-slug",
        organizationSlug,
        "--surprise",
      ]),
    ).toThrow("Unknown flag");
    expect(() =>
      parsePrepareMcpServiceClientScopesArguments([
        "--target-environment",
        "preview",
        "--target-environment",
        "staging",
        "--organization-slug",
        organizationSlug,
      ]),
    ).toThrow("Duplicate flag");
  });

  it("requires the exact runtime organization and production confirmation", () => {
    expect(() =>
      resolvePrepareMcpServiceClientScopesDeployment(options(false), {}),
    ).toThrow("DATABASE_URL");
    expect(() =>
      resolvePrepareMcpServiceClientScopesDeployment(options(false), {
        DATABASE_URL: databaseUrl,
        DASHBOARD_ORG_SLUG: "another-organization",
      }),
    ).toThrow("Organization slug mismatch");
    expect(() =>
      resolvePrepareMcpServiceClientScopesDeployment(options(true), {
        DATABASE_URL: databaseUrl,
        DASHBOARD_ORG_SLUG: organizationSlug,
        VERCEL_ENV: "production",
      }),
    ).toThrow("--confirm-production");
    expect(deployment()).toMatchObject({
      endpointHost,
      organizationSlug,
      sourceRuntimeVersion: "1.6.30",
      targetEnvironment: "preview",
    });
  });

  it("fails before planning when migration, marker, or organization is wrong", async () => {
    const beforeExpand = await migrateThrough("0057");
    await expect(
      prepareMcpServiceClientScopes(
        beforeExpand.db,
        deployment(),
        options(false),
      ),
    ).rejects.toThrow("migration 0058 is incomplete");

    const partialExpand = await migrateThrough();
    await partialExpand.client.exec(
      "ALTER TABLE oauth_client DROP COLUMN application_type",
    );
    await expect(
      prepareMcpServiceClientScopes(
        partialExpand.db,
        deployment(),
        options(false),
      ),
    ).rejects.toThrow("column public.oauth_client.application_type");

    const wrongMarker = await migrateThrough();
    await wrongMarker.client.exec(
      "UPDATE env_marker SET env = 'staging' WHERE id = 1",
    );
    await expect(
      prepareMcpServiceClientScopes(
        wrongMarker.db,
        deployment(),
        options(false),
      ),
    ).rejects.toThrow("environment mismatch");
    await wrongMarker.client.exec(`
      UPDATE env_marker
      SET env = 'preview', endpoint_host = 'other.example.neon.tech'
      WHERE id = 1
    `);
    await expect(
      prepareMcpServiceClientScopes(
        wrongMarker.db,
        deployment(),
        options(false),
      ),
    ).rejects.toThrow("endpoint mismatch");

    const missingOrg = await migrateThrough();
    await missingOrg.client.exec("DELETE FROM organization");
    await expect(
      prepareMcpServiceClientScopes(
        missingOrg.db,
        deployment(),
        options(false),
      ),
    ).rejects.toThrow("Organization slug resolution failed");
  }, 30_000);

  it("keeps dry-run immutable, ignores ordinary public DCR clients, and emits no IDs or secrets", async () => {
    const migrated = await migrateThrough();
    const service = await seedClient(migrated.db);
    const dcr = await seedClient(migrated.db, {
      clientId: "ordinary-public-dcr",
      clientSecret: null,
      grantTypes: ["authorization_code", "refresh_token"],
      public: true,
      tokenEndpointAuthMethod: "none",
      userId: null,
      clientCredentialsScopes: [],
    });
    const before = await credentialsState(migrated.client);
    const close = vi.fn(async () => undefined);
    const output: string[] = [];

    await runPrepareMcpServiceClientScopesCli(
      [
        "--target-environment",
        "preview",
        "--organization-slug",
        organizationSlug,
      ],
      {
        environment: {
          DATABASE_URL: databaseUrl,
          DASHBOARD_ORG_SLUG: organizationSlug,
        },
        openDatabase: async () => ({ db: migrated.db, close }),
        write: (text) => output.push(text),
      },
    );

    expect(await credentialsState(migrated.client)).toEqual(before);
    expect(close).toHaveBeenCalledOnce();
    expect(output.join("\n")).toContain("planned mutations: service_clients=1");
    expect(output.join("\n")).toContain("ignored_non_service=1");
    expect(output.join("\n")).not.toContain(service.clientId);
    expect(output.join("\n")).not.toContain(service.clientSecret);
    expect(output.join("\n")).not.toContain(dcr.clientId);
  }, 30_000);

  it("treats an inventory with zero service candidates as a safe zero delta", async () => {
    const migrated = await migrateThrough();
    await seedClient(migrated.db, {
      clientSecret: null,
      grantTypes: ["authorization_code", "refresh_token"],
      public: true,
      tokenEndpointAuthMethod: "none",
      clientCredentialsScopes: [],
    });

    const result = await prepareMcpServiceClientScopes(
      migrated.db,
      deployment(),
      options(false),
    );
    expect(result.counts.serviceCandidates).toBe(0);
    expect(result.counts.ignoredNonServiceClients).toBe(1);
    expect(result.planned.serviceClients).toBe(0);
  }, 30_000);

  it("copies verified scopes byte-for-byte, preserves all other fields, and is idempotent", async () => {
    const migrated = await migrateThrough();
    const expectedScopes = [
      "prompts:write",
      "mcp:read",
      "prompts:write",
      "workflows:write",
      "tickets:write",
    ];
    await seedClient(migrated.db, {
      scopes: expectedScopes,
      tokenEndpointAuthMethod: "client_secret_post",
      type: null,
    });
    const before = await credentialsState(migrated.client);

    const first = await prepareMcpServiceClientScopes(
      migrated.db,
      deployment(true),
      options(true),
    );
    const after = await credentialsState(migrated.client);
    expect(first.planned).toEqual({ serviceClients: 1 });
    expect(first.applied).toEqual({ serviceClients: 1 });
    expect(after[0].client_credentials_scopes).toEqual(expectedScopes);
    expect(after[0].protected).toEqual(before[0].protected);
    expect(after).toHaveLength(before.length);

    const second = await prepareMcpServiceClientScopes(
      migrated.db,
      deployment(true),
      options(true),
    );
    expect(second.planned).toEqual({ serviceClients: 0 });
    expect(second.applied).toEqual({ serviceClients: 0 });
    expect(await credentialsState(migrated.client)).toEqual(after);
  }, 30_000);

  it("rolls back the complete transaction when a post-write step fails", async () => {
    const migrated = await migrateThrough();
    await seedClient(migrated.db);

    await expect(
      prepareMcpServiceClientScopes(
        migrated.db,
        deployment(true),
        options(true),
        {
          afterWrites: async () => {
            throw new Error("forced post-write failure");
          },
        },
      ),
    ).rejects.toThrow("forced post-write failure");
    expect((await credentialsState(migrated.client))[0].client_credentials_scopes).toEqual(
      [],
    );
  }, 30_000);

  it("blocks every unsafe legacy shape and reports only category counts", async () => {
    const migrated = await migrateThrough();
    await migrated.db.insert(schema.organization).values({
      id: "org-other",
      name: "Other",
      slug: "other",
    });
    await migrated.db.insert(schema.user).values({
      id: "fixture-user",
      name: "Fixture",
      email: "fixture@example.com",
      emailVerified: true,
    });
    const unsafe = [
      await seedClient(migrated.db, {
        grantTypes: ["client_credentials", "authorization_code"],
      }),
      await seedClient(migrated.db, {
        grantTypes: ["client_credentials", "client_credentials"],
      }),
      await seedClient(migrated.db, { public: true }),
      await seedClient(migrated.db, { public: null }),
      await seedClient(migrated.db, { disabled: true }),
      await seedClient(migrated.db, { disabled: null }),
      await seedClient(migrated.db, { userId: "fixture-user" }),
      await seedClient(migrated.db, { referenceId: "org-other" }),
      await seedClient(migrated.db, { referenceId: null }),
      await seedClient(migrated.db, { clientSecret: null }),
      await seedClient(migrated.db, { clientSecret: "" }),
      await seedClient(migrated.db, { clientSecret: "   " }),
      await seedClient(migrated.db, { tokenEndpointAuthMethod: null }),
      await seedClient(migrated.db, { tokenEndpointAuthMethod: "none" }),
      await seedClient(migrated.db, { type: "native" }),
      await seedClient(migrated.db, { clientDiscoveryId: "discovery" }),
      await seedClient(migrated.db, { applicationType: "web" }),
      await seedClient(migrated.db, { scopes: null }),
      await seedClient(migrated.db, { scopes: [] }),
      await seedClient(migrated.db, {
        scopes: [null] as unknown as string[],
      }),
      await seedClient(migrated.db, { scopes: [""] }),
      await seedClient(migrated.db, { scopes: [" mcp:read"] }),
      await seedClient(migrated.db, { scopes: ["unknown:scope"] }),
      await seedClient(migrated.db, { scopes: ["offline_access"] }),
      await seedClient(migrated.db, { clientCredentialsScopes: null }),
      await seedClient(migrated.db, {
        scopes: ["mcp:read", "runs:dispatch"],
        clientCredentialsScopes: ["runs:dispatch", "mcp:read"],
      }),
      await seedClient(migrated.db, {
        grantTypes: ["authorization_code"],
        public: true,
        clientSecret: null,
        tokenEndpointAuthMethod: "none",
        clientCredentialsScopes: ["mcp:read"],
      }),
    ];
    const safePending = await seedClient(migrated.db);
    const before = await credentialsState(migrated.client);

    let message = "";
    try {
      await prepareMcpServiceClientScopes(
        migrated.db,
        deployment(),
        options(false),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("blockedRows=27");
    for (const category of [
      "invalidGrantTypes=2",
      "publicOrUnset=2",
      "disabledOrUnset=2",
      "userOwned=1",
      "wrongOrganization=2",
      "missingSecret=3",
      "invalidAuthMethod=2",
      "invalidLegacyType=1",
      "clientDiscoveryIdSet=1",
      "applicationTypeSet=1",
      "missingScopes=2",
      "nullScope=1",
      "emptyScope=1",
      "whitespaceScope=1",
      "unknownScope=1",
      "offlineAccessScope=1",
      "nullPrefill=1",
      "mismatchedPrefill=1",
      "nonClientCredentialsPrefill=1",
    ]) {
      expect(message).toContain(category);
    }
    for (const row of unsafe) {
      expect(message).not.toContain(row.clientId);
      if (row.clientSecret) expect(message).not.toContain(row.clientSecret);
    }
    expect(message).not.toContain(safePending.clientId);
    await expect(
      prepareMcpServiceClientScopes(
        migrated.db,
        deployment(true),
        options(true),
      ),
    ).rejects.toThrow("blockedRows=27");
    expect(await credentialsState(migrated.client)).toEqual(before);
  }, 30_000);

  it("accepts an exact prefill and reconciles a client created after the first run", async () => {
    const migrated = await migrateThrough();
    const scopes = ["runs:dispatch", "mcp:read", "runs:dispatch"];
    await seedClient(migrated.db, {
      scopes,
      clientCredentialsScopes: scopes,
    });
    const first = await prepareMcpServiceClientScopes(
      migrated.db,
      deployment(true),
      options(true),
    );
    expect(first.applied.serviceClients).toBe(0);

    await seedClient(migrated.db, { scopes: ["mcp:read"] });
    const nextDryRun = await prepareMcpServiceClientScopes(
      migrated.db,
      deployment(),
      options(false),
    );
    expect(nextDryRun.planned.serviceClients).toBe(1);
    const nextApply = await prepareMcpServiceClientScopes(
      migrated.db,
      deployment(true),
      options(true),
    );
    expect(nextApply.applied.serviceClients).toBe(1);
    expect(nextApply.counts.pendingServiceCandidates).toBe(0);
  }, 30_000);

  it("refuses apply after the source runtime changes but still permits inspection", async () => {
    const migrated = await migrateThrough();
    await seedClient(migrated.db);
    const postSwitch = { ...deployment(), sourceRuntimeVersion: "1.7.2" };

    const dryRun = await prepareMcpServiceClientScopes(
      migrated.db,
      postSwitch,
      options(false),
    );
    expect(dryRun.sourceRuntimeVersion).toBe("1.7.2");
    await expect(
      prepareMcpServiceClientScopes(
        migrated.db,
        postSwitch,
        options(true),
      ),
    ).rejects.toThrow("must be exactly 1.6.30");
    expect((await credentialsState(migrated.client))[0].client_credentials_scopes).toEqual(
      [],
    );
  }, 30_000);

  it("refuses a post-switch CLI apply before opening a database connection", async () => {
    const openDatabase = vi.fn(async () => {
      throw new Error("must not connect");
    });
    await expect(
      runPrepareMcpServiceClientScopesCli(
        [
          "--apply",
          "--confirm-legacy-runtime-1-6",
          "--target-environment",
          "preview",
          "--organization-slug",
          organizationSlug,
        ],
        {
          environment: {
            DATABASE_URL: databaseUrl,
            DASHBOARD_ORG_SLUG: organizationSlug,
          },
          openDatabase,
          sourceRuntimeVersion: "1.7.2",
        },
      ),
    ).rejects.toThrow("must be exactly 1.6.30");
    expect(openDatabase).not.toHaveBeenCalled();
  });

  it("refuses apply from the real unmocked post-switch package before connecting", () => {
    const scriptPath = fileURLToPath(
      new URL("../../scripts/prepare-mcp-service-client-scopes.ts", import.meta.url),
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        scriptPath,
        "--apply",
        "--confirm-legacy-runtime-1-6",
        "--target-environment",
        "preview",
        "--organization-slug",
        organizationSlug,
      ],
      {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          DATABASE_URL: databaseUrl,
          DASHBOARD_ORG_SLUG: organizationSlug,
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "must be exactly 1.6.30; found 1.7.2",
    );
    expect(result.stderr).not.toContain("ECONN");
  });

  it("rolls back protected-field changes made after the scoped update", async () => {
    const migrated = await migrateThrough();
    await seedClient(migrated.db);
    const before = await credentialsState(migrated.client);

    await expect(
      prepareMcpServiceClientScopes(
        migrated.db,
        deployment(true),
        options(true),
        {
          afterWrites: async (db) => {
            await db.execute(
              // Deliberately simulates an accidental adjacent write.
              // The postcondition must detect it and roll the transaction back.
              sql`UPDATE oauth_client SET name = 'tampered'`,
            );
          },
        },
      ),
    ).rejects.toThrow("protected oauth_client data changed");
    expect(await credentialsState(migrated.client)).toEqual(before);
  }, 30_000);
});
