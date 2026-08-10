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

describe("0044 workflow run PR lookup migration", () => {
  it("adds the jsonb containment index used by sibling lookup", async () => {
    const client = await migrateThrough("0044");
    const result = await client.query<{ indexdef: string }>(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'workflow_runs_prs_gin_idx'
    `);
    expect(result.rows[0]?.indexdef).toContain(
      "USING gin (prs jsonb_path_ops)",
    );
  });
});
