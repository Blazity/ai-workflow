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

function migrationFile(prefix: string): string {
  const match = readdirSync(migrationsDir).find(
    (file) => file.startsWith(prefix) && file.endsWith(".sql"),
  );
  if (!match) throw new Error(`missing ${prefix} migration`);
  return match;
}

describe("0032 ticket provider-call fencing migration", () => {
  it("backfills legacy ambiguity, treats consumed echoes as finished, and fences old adapters", async () => {
    const client = await migrateThrough("0031");
    await client.exec(`
      INSERT INTO active_runs
        (subject_key, ticket_key, owner_token, run_id, state)
      VALUES
        ('ticket:jira:AIW-1', 'AIW-1', 'owner-1', 'run-1', 'bound');

      INSERT INTO ticket_transition_intents
        (ticket_key, subject_key, owner_token, run_id, actor_account_id,
         target_status_name, webhook_identifier, consumed_at, expires_at)
      VALUES
        ('AIW-1', 'ticket:jira:AIW-1', 'owner-1', 'run-1', 'jira-bot',
         'AI', 'consumed-legacy', now(), now() + interval '2 hours'),
        ('AIW-1', 'ticket:jira:AIW-1', 'owner-1', 'run-1', 'jira-bot',
         'AI Review', NULL, NULL, now() + interval '2 hours');
    `);

    await client.exec(
      readFileSync(`${migrationsDir}${migrationFile("0032")}`, "utf8"),
    );

    const intents = await client.query<{
      webhook_identifier: string | null;
      provider_started_at: Date | null;
      provider_finished_at: Date | null;
      expires_at: Date;
    }>(`
      SELECT
        webhook_identifier,
        provider_started_at,
        provider_finished_at,
        expires_at
      FROM ticket_transition_intents
      ORDER BY id
    `);
    expect(intents.rows[0]).toMatchObject({
      webhook_identifier: "consumed-legacy",
      provider_started_at: expect.any(Date),
      provider_finished_at: expect.any(Date),
    });
    expect(intents.rows[0]!.expires_at.getTime() - Date.now()).toBeGreaterThan(
      29 * 24 * 60 * 60 * 1000,
    );
    expect(intents.rows[1]).toMatchObject({
      webhook_identifier: null,
      provider_started_at: expect.any(Date),
      provider_finished_at: null,
    });

    const owner = await client.query<{
      ticket_provider_calls_in_flight: number;
      ticket_mutation_version: number;
    }>(`
      SELECT ticket_provider_calls_in_flight, ticket_mutation_version
      FROM active_runs
      WHERE subject_key = 'ticket:jira:AIW-1'
    `);
    expect(owner.rows).toEqual([
      { ticket_provider_calls_in_flight: 1, ticket_mutation_version: 1 },
    ]);

    await expect(
      client.exec(`DELETE FROM active_runs WHERE subject_key = 'ticket:jira:AIW-1'`),
    ).rejects.toThrow(/unfinished ticket provider calls/i);
    await expect(
      client.exec(`
        UPDATE active_runs
        SET owner_token = 'old-pod-handoff', run_id = NULL, state = 'reserved'
        WHERE subject_key = 'ticket:jira:AIW-1'
      `),
    ).rejects.toThrow(/unfinished ticket provider calls/i);
    await client.exec(`
      UPDATE active_runs SET state = 'cancelling'
      WHERE subject_key = 'ticket:jira:AIW-1'
    `);
  });

  it("marks an old-pod insert started by default and rejects it after owner release", async () => {
    const client = await migrateThrough("0032");
    await client.exec(`
      INSERT INTO active_runs
        (subject_key, ticket_key, owner_token, run_id, state)
      VALUES
        ('ticket:jira:AIW-2', 'AIW-2', 'owner-2', 'run-2', 'bound');

      INSERT INTO ticket_transition_intents
        (ticket_key, subject_key, owner_token, run_id, actor_account_id,
         target_status_name, expires_at)
      VALUES
        ('AIW-2', 'ticket:jira:AIW-2', 'owner-2', 'run-2', 'jira-bot',
         'AI Review', now() + interval '2 hours');
    `);

    const owner = await client.query<{
      ticket_provider_calls_in_flight: number;
      ticket_mutation_version: number;
    }>(`
      SELECT ticket_provider_calls_in_flight, ticket_mutation_version
      FROM active_runs
      WHERE subject_key = 'ticket:jira:AIW-2'
    `);
    expect(owner.rows).toEqual([
      { ticket_provider_calls_in_flight: 1, ticket_mutation_version: 1 },
    ]);

    await client.exec(`
      UPDATE ticket_transition_intents
      SET provider_finished_at = now()
      WHERE subject_key = 'ticket:jira:AIW-2'
    `);
    await client.exec(`DELETE FROM active_runs WHERE subject_key = 'ticket:jira:AIW-2'`);

    await expect(
      client.exec(`
        INSERT INTO ticket_transition_intents
          (ticket_key, subject_key, owner_token, run_id, actor_account_id,
           target_status_name, expires_at)
        VALUES
          ('AIW-2', 'ticket:jira:AIW-2', 'owner-2', 'run-2', 'jira-bot',
           'Done', now() + interval '2 hours')
      `),
    ).rejects.toThrow(/no exact active owner/i);
  });
});

describe("0033 ticket cancellation protocol migration", () => {
  it("blocks old pods from opening or releasing an unreconciled ticket cancellation", async () => {
    const client = await migrateThrough("0032");
    await client.exec(`
      INSERT INTO active_runs
        (subject_key, ticket_key, owner_token, run_id, state)
      VALUES
        ('ticket:jira:AIW-3', 'AIW-3', 'owner-3', 'run-3', 'bound'),
        ('ticket:jira:AIW-4', 'AIW-4', 'owner-4', 'run-4', 'bound');

      UPDATE active_runs
      SET state = 'cancelling'
      WHERE subject_key = 'ticket:jira:AIW-4';
    `);

    await client.exec(
      readFileSync(`${migrationsDir}${migrationFile("0033")}`, "utf8"),
    );

    await expect(
      client.exec(`
        UPDATE active_runs
        SET state = 'cancelling'
        WHERE subject_key = 'ticket:jira:AIW-3'
      `),
    ).rejects.toThrow(/cancellation protocol marker/i);

    await client.exec(`
      UPDATE active_runs
      SET state = 'cancelling', ticket_cancellation_reconciled_version = -1
      WHERE subject_key = 'ticket:jira:AIW-3'
    `);

    await client.exec(`
      INSERT INTO ticket_transition_intents
        (ticket_key, subject_key, owner_token, run_id, actor_account_id,
         target_status_name, expires_at)
      VALUES
        ('AIW-3', 'ticket:jira:AIW-3', 'owner-3', 'run-3', 'jira-bot',
         'AI Review', now() + interval '2 hours');

      UPDATE ticket_transition_intents
      SET provider_finished_at = now()
      WHERE subject_key = 'ticket:jira:AIW-3';
    `);
    await expect(
      client.exec(`DELETE FROM active_runs WHERE subject_key = 'ticket:jira:AIW-3'`),
    ).rejects.toThrow(/cancellation has not been reconciled/i);

    const backfilled = await client.query<{
      ticket_cancellation_reconciled_version: number | null;
    }>(`
      SELECT ticket_cancellation_reconciled_version
      FROM active_runs
      WHERE subject_key = 'ticket:jira:AIW-4'
    `);
    expect(backfilled.rows).toEqual([
      { ticket_cancellation_reconciled_version: -2 },
    ]);
    await expect(
      client.exec(`
        UPDATE active_runs
        SET ticket_cancellation_reconciled_version = ticket_mutation_version
        WHERE subject_key = 'ticket:jira:AIW-4'
      `),
    ).rejects.toThrow(/legacy cancellation requires manual reconciliation/i);
    await expect(
      client.exec(`DELETE FROM active_runs WHERE subject_key = 'ticket:jira:AIW-4'`),
    ).rejects.toThrow(/cancellation has not been reconciled/i);

    await client.exec(`
      UPDATE active_runs
      SET ticket_cancellation_reconciled_version = ticket_mutation_version
      WHERE subject_key = 'ticket:jira:AIW-3';
      DELETE FROM active_runs
      WHERE subject_key = 'ticket:jira:AIW-3';
    `);
    const remaining = await client.query<{ subject_key: string }>(`
      SELECT subject_key FROM active_runs
    `);
    expect(remaining.rows).toEqual([{ subject_key: "ticket:jira:AIW-4" }]);
  });
});

describe("0034 ticket label provider-call fencing migration", () => {
  it("counts label calls and applies the old-pod owner guard until they finish", async () => {
    const client = await migrateThrough("0034");
    await client.exec(`
      INSERT INTO active_runs
        (subject_key, ticket_key, owner_token, run_id, state)
      VALUES
        ('ticket:jira:AIW-5', 'AIW-5', 'owner-5', 'run-5', 'bound');

      INSERT INTO ticket_label_mutation_intents
        (ticket_key, subject_key, owner_token, run_id, remove_labels, expires_at)
      VALUES
        ('AIW-5', 'ticket:jira:AIW-5', 'owner-5', 'run-5',
         ARRAY['needs-clarification'], now() + interval '2 hours');
    `);

    const started = await client.query<{
      ticket_provider_calls_in_flight: number;
      ticket_mutation_version: number;
    }>(`
      SELECT ticket_provider_calls_in_flight, ticket_mutation_version
      FROM active_runs
      WHERE subject_key = 'ticket:jira:AIW-5'
    `);
    expect(started.rows).toEqual([
      { ticket_provider_calls_in_flight: 1, ticket_mutation_version: 1 },
    ]);
    await expect(
      client.exec(`
        UPDATE active_runs
        SET owner_token = 'old-pod-handoff', run_id = NULL, state = 'reserved'
        WHERE subject_key = 'ticket:jira:AIW-5'
      `),
    ).rejects.toThrow(/unfinished ticket provider calls/i);

    await client.exec(`
      UPDATE ticket_label_mutation_intents
      SET provider_finished_at = now()
      WHERE subject_key = 'ticket:jira:AIW-5'
    `);
    const finished = await client.query<{ ticket_provider_calls_in_flight: number }>(`
      SELECT ticket_provider_calls_in_flight
      FROM active_runs
      WHERE subject_key = 'ticket:jira:AIW-5'
    `);
    expect(finished.rows).toEqual([{ ticket_provider_calls_in_flight: 0 }]);
  });
});
