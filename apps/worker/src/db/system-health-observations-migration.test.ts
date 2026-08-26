import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));

describe("0054 system health observations migration", () => {
  it("adds the bounded counter without changing existing workflow data", async () => {
    const client = new PGlite();
    const migrations = readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql") && file.slice(0, 4) <= "0053")
      .sort();
    for (const file of migrations) {
      await client.exec(readFileSync(`${migrationsDir}${file}`, "utf8"));
    }
    await client.exec(
      `INSERT INTO workflow_runs (run_id, status) VALUES ('health-migration-run', 'success')`,
    );

    await client.exec(
      readFileSync(`${migrationsDir}0054_curved_mathemanic.sql`, "utf8"),
    );
    await client.exec(`
      INSERT INTO system_health_observation_counters
        (integration_id, check_id, scope, window_start, outcome, reason, count, last_observed_at)
      VALUES
        ('gitlab', 'webhook-delivery', 'deployment', '2026-08-21', 'rejected', 'invalid_token', 2, '2026-08-21T10:00:00Z')
    `);

    const run = await client.query<{ run_id: string; status: string }>(
      `SELECT run_id, status FROM workflow_runs WHERE run_id = 'health-migration-run'`,
    );
    const counter = await client.query<{ count: number }>(
      `SELECT count FROM system_health_observation_counters WHERE integration_id = 'gitlab'`,
    );
    expect(run.rows).toEqual([{ run_id: "health-migration-run", status: "success" }]);
    expect(counter.rows).toEqual([{ count: 2 }]);
  });
});
