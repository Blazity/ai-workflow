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

describe("0032 PR review resource migration", () => {
  it("creates durable check and review publication resources", async () => {
    const client = await migrateThrough("0032");
    const tables = await client.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'workflow_run_external_checks',
          'workflow_pr_review_publications',
          'workflow_pr_review_publication_comments'
        )
      ORDER BY table_name
    `);
    expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
      "workflow_pr_review_publication_comments",
      "workflow_pr_review_publications",
      "workflow_run_external_checks",
    ]);
  });

  it("upgrades an existing run without rewriting it", async () => {
    const client = await migrateThrough("0031");
    await client.exec(`
      INSERT INTO workflow_runs (run_id, status)
      VALUES ('run-existing', 'success')
    `);
    await client.exec(
      readFileSync(`${migrationsDir}0032_pr_review_resources.sql`, "utf8"),
    );
    const runs = await client.query<{ run_id: string; status: string }>(`
      SELECT run_id, status FROM workflow_runs WHERE run_id = 'run-existing'
    `);
    expect(runs.rows).toEqual([
      { run_id: "run-existing", status: "success" },
    ]);
  });
});
