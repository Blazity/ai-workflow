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

describe("0022 owner-CAS and durable trigger delivery migration", () => {
  it("backfills legacy owners and enforces immutable definition-version references", async () => {
    const client = await migrateThrough("0021");
    await client.exec(`
      INSERT INTO active_runs (ticket_key, run_id, sandbox_id, run_kind)
      VALUES
        ('PROJ-1', 'run-1', 'sandbox-1', 'ticket'),
        ('PROJ-2', 'claiming:123', NULL, 'ticket');

      INSERT INTO workflow_definitions
        (name, enabled, builtin_fallback, trigger_types, created_by_id, created_by_label)
      VALUES
        ('PR flow', true, false, '{trigger_pr_created}', 'admin', 'Admin');

      INSERT INTO workflow_definition_versions
        (definition_id, version, definition, created_by_id, created_by_label)
      VALUES
        (2, 1, '{}'::jsonb, 'admin', 'Admin');
    `);

    await client.exec(
      readFileSync(`${migrationsDir}0022_owner_cas_trigger_delivery.sql`, "utf8"),
    );

    const owners = await client.query<{
      subject_key: string;
      ticket_key: string | null;
      owner_token: string;
      run_id: string | null;
      state: string;
    }>(`
      SELECT subject_key, ticket_key, owner_token, run_id, state
      FROM active_runs
      ORDER BY subject_key
    `);
    expect(owners.rows).toEqual([
      {
        subject_key: "ticket:jira:PROJ-1",
        ticket_key: "PROJ-1",
        owner_token: "legacy:run-1",
        run_id: "run-1",
        state: "bound",
      },
      {
        subject_key: "ticket:jira:PROJ-2",
        ticket_key: "PROJ-2",
        owner_token: "legacy:claiming:123",
        run_id: null,
        state: "reserved",
      },
    ]);

    const sandboxes = await client.query<{
      subject_key: string;
      owner_token: string;
      sandbox_id: string;
    }>(`
      SELECT subject_key, owner_token, sandbox_id
      FROM active_run_sandboxes
    `);
    expect(sandboxes.rows).toEqual([
      {
        subject_key: "ticket:jira:PROJ-1",
        owner_token: "legacy:run-1",
        sandbox_id: "sandbox-1",
      },
    ]);

    const constraints = await client.query<{ conname: string }>(`
      SELECT conname
      FROM pg_constraint
      WHERE conname IN (
        'trigger_deliveries_definition_version_fk',
        'pending_trigger_events_definition_version_fk'
      )
      ORDER BY conname
    `);
    expect(constraints.rows.map((row) => row.conname)).toEqual([
      "pending_trigger_events_definition_version_fk",
      "trigger_deliveries_definition_version_fk",
    ]);

    await client.exec(`
      INSERT INTO trigger_deliveries
        (provider, delivery_id, producer, trigger_type, subject_key, head_sha,
         definition_id, definition_version, payload)
      VALUES
        ('github', 'delivery-valid', 'github', 'trigger_pr_created',
         'pr:github:acme/app#1', 'abc', 2, 1, '{}'::jsonb);

      INSERT INTO pending_trigger_events
        (subject_key, head_sha, trigger_type, provider, delivery_id,
         definition_id, definition_version, payload)
      VALUES
        ('pr:github:acme/app#1', 'abc', 'trigger_pr_created', 'github',
         'delivery-valid', 2, 1, '{}'::jsonb);
    `);

    await expect(
      client.exec(`
        INSERT INTO trigger_deliveries
          (provider, delivery_id, producer, trigger_type, subject_key, head_sha,
           definition_id, definition_version, payload)
        VALUES
          ('github', 'delivery-invalid', 'github', 'trigger_pr_created',
           'pr:github:acme/app#2', 'def', 2, 999, '{}'::jsonb)
      `),
    ).rejects.toThrow();
    await expect(
      client.exec(`
        INSERT INTO pending_trigger_events
          (subject_key, head_sha, trigger_type, provider, delivery_id,
           definition_id, definition_version, payload)
        VALUES
          ('pr:github:acme/app#2', 'def', 'trigger_pr_created', 'github',
           'delivery-invalid', 2, 999, '{}'::jsonb)
      `),
    ).rejects.toThrow();
  });
});
