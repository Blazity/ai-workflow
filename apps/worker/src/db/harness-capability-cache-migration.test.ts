import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));

async function migrateThrough(lastPrefix: string): Promise<PGlite> {
  const client = new PGlite();
  const files = readdirSync(migrationsDir)
    .filter(
      (file) => file.endsWith(".sql") && file.slice(0, 4) <= lastPrefix,
    )
    .sort();
  for (const file of files) {
    await client.exec(readFileSync(`${migrationsDir}${file}`, "utf8"));
  }
  return client;
}

describe("0031 Harness capability cache migration", () => {
  it("creates the organization-scoped capability cache and indexes", async () => {
    const client = await migrateThrough("0031");
    const columns = await client.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'harness_capability_catalogs'
      ORDER BY column_name
    `);
    expect(columns.rows.map(({ column_name }) => column_name)).toEqual(
      expect.arrayContaining([
        "organization_id",
        "provider",
        "cli_version",
        "catalog",
        "catalog_hash",
        "fetched_at",
        "last_refresh_failed_at",
        "last_refresh_error",
      ]),
    );
    const indexes = await client.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'harness_capability_catalogs'
    `);
    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual(
      expect.arrayContaining([
        "harness_capability_catalogs_scope_unique",
        "harness_capability_catalogs_organization_idx",
      ]),
    );
  });

  it("upgrades an existing database without changing stored profile versions", async () => {
    const client = await migrateThrough("0030");
    await client.exec(`
      INSERT INTO organization (id, name, slug)
      VALUES ('org-existing', 'Existing organization', 'existing-org');
      INSERT INTO harness_profiles (
        id,
        organization_id,
        slug,
        draft_manifest,
        created_by_id,
        updated_by_id
      )
      VALUES (
        'profile-existing',
        'org-existing',
        'existing-profile',
        '{}'::jsonb,
        'admin',
        'admin'
      )
    `);
    await client.exec(
      readFileSync(`${migrationsDir}0031_capability_cache.sql`, "utf8"),
    );
    const rows = await client.query<{ id: string; slug: string }>(`
      SELECT id, slug
      FROM harness_profiles
      WHERE id = 'profile-existing'
    `);
    expect(rows.rows).toEqual([
      { id: "profile-existing", slug: "existing-profile" },
    ]);
  });
});
