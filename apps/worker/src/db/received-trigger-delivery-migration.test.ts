import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));

async function migrateThrough(lastPrefix: string): Promise<PGlite> {
  const client = new PGlite();
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql") && file.slice(0, 4) <= lastPrefix)
    .sort();
  for (const file of files) {
    await client.exec(readFileSync(`${migrationsDir}${file}`, "utf8"));
  }
  return client;
}

describe("0026 received trigger delivery migration", () => {
  it("allows a provider delivery to be persisted before subject enrichment", async () => {
    const client = await migrateThrough("0025");

    await client.exec(`
      INSERT INTO workflow_definitions
        (name, enabled, builtin_fallback, trigger_types, created_by_id, created_by_label)
      VALUES
        ('PR flow', true, false, '{trigger_pr_created}', 'admin', 'Admin');

      INSERT INTO workflow_definition_versions
        (definition_id, version, definition, created_by_id, created_by_label)
      VALUES
        (2, 1, '{}'::jsonb, 'admin', 'Admin');

      INSERT INTO trigger_deliveries
        (provider, delivery_id, producer, trigger_type, subject_key, head_sha,
         definition_id, definition_version, payload, status, result)
      VALUES
        ('github', 'legacy-accepted', 'github', 'trigger_pr_created',
         'pr:github:acme/app#1', 'abc', 2, 1, '{}'::jsonb, 'accepted', NULL),
        ('github', 'legacy-completed', 'github', 'trigger_pr_created',
         'pr:github:acme/app#2', 'def', 2, 1, '{}'::jsonb, 'completed',
         '{"result":"coalesced"}'::jsonb);
    `);

    await client.exec(
      readFileSync(`${migrationsDir}0026_tearful_tiger_shark.sql`, "utf8"),
    );

    const subjectColumn = await client.query<{
      is_nullable: string;
    }>(`
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_name = 'trigger_deliveries'
        AND column_name = 'subject_key'
    `);
    expect(subjectColumn.rows).toEqual([{ is_nullable: "YES" }]);

    const constraints = await client.query<{ conname: string }>(`
      SELECT conname
      FROM pg_constraint
      WHERE conname = 'trigger_deliveries_state_check'
    `);
    expect(constraints.rows).toEqual([
      { conname: "trigger_deliveries_state_check" },
    ]);

    await client.exec(`
      INSERT INTO trigger_deliveries
        (provider, delivery_id, producer, trigger_type, subject_key, head_sha,
         definition_id, definition_version, payload, status)
      VALUES
        ('github', 'received', 'github', 'trigger_pr_created', NULL, 'abc',
         2, 1, '{}'::jsonb, 'received');

      UPDATE trigger_deliveries
      SET status = 'completed', result = '{"result":"ignored_stale_head"}'::jsonb
      WHERE provider = 'github' AND delivery_id = 'received';
    `);

    await expect(
      client.exec(`
        INSERT INTO trigger_deliveries
          (provider, delivery_id, producer, trigger_type, subject_key, head_sha,
           definition_id, definition_version, payload, status)
        VALUES
          ('github', 'invalid-accepted', 'github', 'trigger_pr_created', NULL, 'abc',
           2, 1, '{}'::jsonb, 'accepted')
      `),
    ).rejects.toThrow();
  });
});
