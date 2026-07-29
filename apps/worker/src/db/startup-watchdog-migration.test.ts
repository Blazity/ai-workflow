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

describe("0030 startup watchdog migration", () => {
  it("creates the startup metadata and partial nonterminal index", async () => {
    const client = await migrateThrough("0030");
    const columns = await client.query<{
      column_name: string;
      is_nullable: string;
    }>(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'workflow_runs'
        AND column_name IN (
          'entry_started_at',
          'startup_deadline_at',
          'diagnostic_id'
        )
      ORDER BY column_name
    `);
    expect(columns.rows).toEqual([
      { column_name: "diagnostic_id", is_nullable: "YES" },
      { column_name: "entry_started_at", is_nullable: "YES" },
      { column_name: "startup_deadline_at", is_nullable: "YES" },
    ]);
    const indexes = await client.query<{ indexdef: string }>(`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'workflow_runs_startup_watchdog_idx'
    `);
    expect(indexes.rows[0]?.indexdef).toContain(
      "WHERE ((entry_started_at IS NULL)",
    );
    expect(indexes.rows[0]?.indexdef).toContain("startup_deadline_at");
  });

  it("upgrades existing runs without manufacturing startup state", async () => {
    const client = await migrateThrough("0029");
    await client.exec(`
      INSERT INTO workflow_runs (run_id, status, updated_at)
      VALUES ('legacy-run', 'running', now())
    `);
    await client.exec(
      readFileSync(`${migrationsDir}0030_startup_watchdog.sql`, "utf8"),
    );
    const rows = await client.query<{
      run_id: string;
      status: string;
      entry_started_at: Date | null;
      startup_deadline_at: Date | null;
      diagnostic_id: string | null;
    }>(`
      SELECT run_id, status, entry_started_at, startup_deadline_at, diagnostic_id
      FROM workflow_runs
      WHERE run_id = 'legacy-run'
    `);
    expect(rows.rows).toEqual([
      {
        run_id: "legacy-run",
        status: "running",
        entry_started_at: null,
        startup_deadline_at: null,
        diagnostic_id: null,
      },
    ]);
  });
});
