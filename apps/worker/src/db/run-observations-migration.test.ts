import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));

function migration(prefix: string): string {
  const file = readdirSync(migrationsDir).find((entry) =>
    entry.startsWith(`${prefix}_`),
  );
  if (!file) throw new Error(`Migration ${prefix} is missing`);
  return readFileSync(`${migrationsDir}${file}`, "utf8");
}

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

describe("0024 run observation migration", () => {
  it("creates fresh replay tables with tenant, lifecycle, and cascade constraints", async () => {
    const client = await migrateThrough("0024");
    const tables = await client.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'workflow_run_observations',
          'workflow_block_attempts'
        )
      ORDER BY table_name
    `);
    expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
      "workflow_block_attempts",
      "workflow_run_observations",
    ]);

    await client.exec(`
      INSERT INTO organization (id, name, slug)
      VALUES
        ('org-replay', 'Replay', 'replay'),
        ('org-other', 'Other', 'other');
      INSERT INTO workflow_definitions
        (name, created_by_id, created_by_label)
      VALUES
        ('Replay workflow', 'admin', 'Admin');
      INSERT INTO workflow_definition_versions
        (definition_id, version, definition, created_by_id, created_by_label)
      SELECT
        id,
        1,
        '{"schemaVersion":2,"nodes":[],"edges":[]}'::jsonb,
        'admin',
        'Admin'
      FROM workflow_definitions
      WHERE name = 'Replay workflow';
      INSERT INTO workflow_runs
        (run_id, replay_organization_id, replay_captured_at, replay_expires_at)
      VALUES
        ('run-replay', 'org-replay', now(), now() + interval '30 days');
      INSERT INTO workflow_run_observations
        (run_id, organization_id, definition_id, definition_version,
         definition_schema_version, graph, layout, runtime_manifest,
         capture_status, expires_at)
      SELECT
        'run-replay',
        'org-replay',
        id,
        1,
        2,
        '{"nodes":[],"edges":[]}'::jsonb,
        '{"nodes":{}}'::jsonb,
        '{"value":{},"metadata":{"redactions":{},"truncated":false,"originalBytes":2,"storedBytes":2,"unavailable":false,"unavailableReason":null}}'::jsonb,
        'available',
        now() + interval '30 days'
      FROM workflow_definitions
      WHERE name = 'Replay workflow';
      INSERT INTO workflow_block_attempts
        (run_id, organization_id, node_id, attempt, activation_scope_id, state)
      VALUES
        ('run-replay', 'org-replay', 'agent', 1, 'root', 'running');
    `);

    await expect(
      client.exec(`
        INSERT INTO workflow_block_attempts
          (run_id, organization_id, node_id, attempt, activation_scope_id, state)
        VALUES
          ('run-replay', 'org-other', 'forged', 1, 'root', 'running')
      `),
    ).rejects.toThrow();
    await expect(
      client.exec(`
        INSERT INTO workflow_block_attempts
          (run_id, organization_id, node_id, attempt, activation_scope_id,
           state, completed_at)
        VALUES
          ('run-replay', 'org-replay', 'invalid-running', 1, 'root',
           'running', now())
      `),
    ).rejects.toThrow();

    await client.exec(`
      DELETE FROM workflow_run_observations
      WHERE run_id = 'run-replay'
    `);
    const attempts = await client.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM workflow_block_attempts
      WHERE run_id = 'run-replay'
    `);
    expect(attempts.rows).toEqual([{ count: 0 }]);
  });

  it("upgrades 0023 data without backfill and strips only nested output fields", async () => {
    const client = await migrateThrough("0023");
    await client.exec(`
      INSERT INTO workflow_runs (run_id, status, block_statuses)
      VALUES (
        'legacy-replay-run',
        'success',
        '{
          "agent": {
            "status": "ok",
            "attempt": 1,
            "output": {"token": "must-not-survive"}
          },
          "failed": {
            "status": "fail",
            "error": "safe diagnostic"
          },
          "corrupt": "preserve-me",
          "nullish": null
        }'::jsonb
      )
    `);
    await client.exec(migration("0024"));

    const runs = await client.query<{
      block_statuses: unknown;
      replay_organization_id: string | null;
      replay_captured_at: Date | null;
      replay_expires_at: Date | null;
      replay_capture_failed_at: Date | null;
    }>(`
      SELECT
        block_statuses,
        replay_organization_id,
        replay_captured_at,
        replay_expires_at,
        replay_capture_failed_at
      FROM workflow_runs
      WHERE run_id = 'legacy-replay-run'
    `);
    expect(runs.rows).toEqual([
      {
        block_statuses: {
          agent: { status: "ok", attempt: 1 },
          failed: { status: "fail", error: "safe diagnostic" },
          corrupt: "preserve-me",
          nullish: null,
        },
        replay_organization_id: null,
        replay_captured_at: null,
        replay_expires_at: null,
        replay_capture_failed_at: null,
      },
    ]);
    const counts = await client.query<{
      observations: number;
      attempts: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM workflow_run_observations) AS observations,
        (SELECT count(*)::int FROM workflow_block_attempts) AS attempts
    `);
    expect(counts.rows).toEqual([{ observations: 0, attempts: 0 }]);
  });
});
