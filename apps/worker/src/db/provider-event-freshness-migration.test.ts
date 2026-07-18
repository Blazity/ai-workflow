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

describe("0025 provider-event freshness migration", () => {
  it("replays from 0024 while preserving and version-isolating pending events", async () => {
    const client = await migrateThrough("0024");
    await client.exec(`
      INSERT INTO workflow_definitions
        (id, name, enabled, builtin_fallback, trigger_types, created_by_id, created_by_label)
      VALUES
        (99, 'PR checks', true, false, '{trigger_pr_checks_failed}', 'admin', 'Admin');

      INSERT INTO workflow_definition_versions
        (definition_id, version, definition, created_by_id, created_by_label)
      VALUES
        (99, 11, '{}'::jsonb, 'admin', 'Admin'),
        (99, 12, '{}'::jsonb, 'admin', 'Admin');

      INSERT INTO pending_trigger_events
        (subject_key, head_sha, trigger_type, provider, delivery_id,
         definition_id, definition_version, payload)
      VALUES
        ('pr:github:acme/app#7', 'abc', 'trigger_pr_checks_failed', 'github',
         'delivery-v11', 99, 11, '{}'::jsonb);
    `);

    await client.exec(
      readFileSync(`${migrationsDir}0025_colossal_exodus.sql`, "utf8"),
    );
    await client.exec(`
      INSERT INTO pending_trigger_events
        (subject_key, head_sha, trigger_type, provider, delivery_id,
         definition_id, definition_version, payload)
      VALUES
        ('pr:github:acme/app#7', 'abc', 'trigger_pr_checks_failed', 'github',
         'delivery-v12', 99, 12, '{}'::jsonb);
    `);

    const pending = await client.query<{
      delivery_id: string;
      definition_version: number;
    }>(`
      SELECT delivery_id, definition_version
      FROM pending_trigger_events
      ORDER BY definition_version
    `);
    expect(pending.rows).toEqual([
      { delivery_id: "delivery-v11", definition_version: 11 },
      { delivery_id: "delivery-v12", definition_version: 12 },
    ]);

    await client.exec(`
      INSERT INTO ticket_transition_intents
        (ticket_key, subject_key, owner_token, actor_account_id,
         target_status_name, webhook_identifier, expires_at)
      VALUES
        ('AIW-92', 'ticket:jira:AIW-92', 'owner-1', 'jira-account-1',
         'In Review', 'webhook-1', now() + interval '1 hour');
    `);
    await expect(
      client.exec(`
        INSERT INTO ticket_transition_intents
          (ticket_key, subject_key, owner_token, actor_account_id,
           target_status_name, webhook_identifier, expires_at)
        VALUES
          ('AIW-92', 'ticket:jira:AIW-92', 'owner-2', 'jira-account-1',
           'In Review', 'webhook-1', now() + interval '1 hour');
      `),
    ).rejects.toThrow();
  });

  it("chains its snapshot directly from the trusted 0024 snapshot", () => {
    type Snapshot = {
      id: string;
      prevId: string;
      tables: Record<
        string,
        { compositePrimaryKeys?: Record<string, { columns: string[] }> }
      >;
    };
    const previous = JSON.parse(
      readFileSync(`${migrationsDir}meta/0024_snapshot.json`, "utf8"),
    ) as Snapshot;
    const current = JSON.parse(
      readFileSync(`${migrationsDir}meta/0025_snapshot.json`, "utf8"),
    ) as Snapshot;

    expect(current.prevId).toBe(previous.id);
    expect(Object.keys(current.tables)).toEqual(
      expect.arrayContaining(Object.keys(previous.tables)),
    );
    expect(
      Object.values(
        current.tables["public.pending_trigger_events"]?.compositePrimaryKeys ?? {},
      )[0]?.columns,
    ).toEqual([
      "subject_key",
      "head_sha",
      "trigger_type",
      "definition_id",
      "definition_version",
    ]);
    expect(current.tables).toHaveProperty("public.ticket_transition_intents");
  });
});
