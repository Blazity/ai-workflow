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

describe("0024 workflow-run subject-key backfill migration", () => {
  it("backfills ticket subjects without overwriting existing PR subjects", async () => {
    const client = await migrateThrough("0023");
    await client.exec(`
      INSERT INTO workflow_runs (run_id, ticket_key, subject_key)
      VALUES
        ('ticket-run', ' proj-42 ', NULL),
        ('pr-run', 'PROJ-42', 'pr:github:acme/app#7'),
        ('uncorrelated-run', NULL, NULL);
    `);

    await client.exec(
      readFileSync(`${migrationsDir}0024_workflow_run_subject_key_backfill.sql`, "utf8"),
    );

    const runs = await client.query<{
      run_id: string;
      subject_key: string | null;
    }>(`
      SELECT run_id, subject_key
      FROM workflow_runs
      ORDER BY run_id
    `);
    expect(runs.rows).toEqual([
      { run_id: "pr-run", subject_key: "pr:github:acme/app#7" },
      { run_id: "ticket-run", subject_key: "ticket:jira:PROJ-42" },
      { run_id: "uncorrelated-run", subject_key: null },
    ]);

    const publishedHeadColumn = await client.query<{
      column_name: string;
      is_nullable: string;
    }>(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'workflow_owned_branches'
        AND column_name = 'published_head_sha'
    `);
    expect(publishedHeadColumn.rows).toEqual([
      { column_name: "published_head_sha", is_nullable: "YES" },
    ]);
  });
});
