import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));

describe("0055 system health scans migration", () => {
  it("adds the single-row scan store without changing existing workflow data", async () => {
    const client = new PGlite();
    const migrations = readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql") && file.slice(0, 4) <= "0054")
      .sort();
    for (const file of migrations) {
      await client.exec(readFileSync(`${migrationsDir}${file}`, "utf8"));
    }
    await client.exec(
      `INSERT INTO workflow_runs (run_id, status) VALUES ('health-scan-migration-run', 'success')`,
    );

    await client.exec(
      readFileSync(`${migrationsDir}0055_system_health_scans.sql`, "utf8"),
    );
    await client.exec(`
      INSERT INTO system_health_scans (generated_at, report)
      VALUES ('2026-08-21T10:00:00Z', '{"generatedAt":"2026-08-21T10:00:00.000Z"}')
    `);

    const run = await client.query<{ run_id: string; status: string }>(
      `SELECT run_id, status FROM workflow_runs WHERE run_id = 'health-scan-migration-run'`,
    );
    const scan = await client.query<{ scope: string }>(
      `SELECT scope FROM system_health_scans`,
    );
    expect(run.rows).toEqual([{ run_id: "health-scan-migration-run", status: "success" }]);
    expect(scan.rows).toEqual([{ scope: "deployment" }]);
  });
});
