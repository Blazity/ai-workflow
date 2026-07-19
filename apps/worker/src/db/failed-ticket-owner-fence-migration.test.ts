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

describe("0035 failed-ticket exact-owner fencing migration", () => {
  it("removes markers already stranded behind cancelling owners", async () => {
    const client = await migrateThrough("0034");
    await client.exec(`
      INSERT INTO active_runs
        (subject_key, ticket_key, owner_token, run_id, state,
         ticket_cancellation_reconciled_version)
      VALUES
        ('ticket:jira:AIW-1', 'AIW-1', 'owner-a', 'run-a', 'cancelling', -1);
      INSERT INTO failed_tickets (ticket_key, run_id, error, failed_at)
      VALUES ('AIW-1', 'run-a', 'stale marker', '2026-07-19T12:00:00.000Z');
    `);

    await client.exec(
      readFileSync(`${migrationsDir}0035_failed_ticket_owner_fence.sql`, "utf8"),
    );

    const markers = await client.query(`SELECT * FROM failed_tickets`);
    expect(markers.rows).toEqual([]);
  });

  it("fences legacy marker writes and legacy cancellation updates below the app", async () => {
    const client = await migrateThrough("0035");
    await client.exec(`
      INSERT INTO active_runs
        (subject_key, ticket_key, owner_token, run_id, state)
      VALUES
        ('ticket:jira:AIW-1', 'AIW-1', 'owner-a', 'run-a', 'bound'),
        ('ticket:jira:AIW-2', 'AIW-2', 'owner-b', 'run-b', 'bound');
      INSERT INTO failed_tickets (ticket_key, run_id, error, failed_at)
      VALUES
        ('AIW-1', 'run-a', 'first marker', '2026-07-19T12:00:00.000Z'),
        ('AIW-2', 'run-b', 'unrelated marker', '2026-07-19T12:00:00.000Z');

      -- This is the exact state-only UPDATE issued by a pod deployed before
      -- the cancellation protocol column existed.
      UPDATE active_runs
      SET state = 'cancelling', updated_at = now()
      WHERE subject_key = 'ticket:jira:AIW-1'
        AND owner_token = 'owner-a'
        AND run_id = 'run-a'
        AND state IN ('reserved', 'bound', 'cancelling');

      -- This is the unconditional upsert issued by an old workflow after its
      -- owner has been closed. The trigger must suppress it without relying on
      -- the new application adapter.
      INSERT INTO failed_tickets (ticket_key, run_id, error, failed_at)
      VALUES ('AIW-1', 'run-a', 'late stale marker', '2026-07-19T12:01:00.000Z')
      ON CONFLICT (ticket_key) DO UPDATE
      SET run_id = EXCLUDED.run_id, error = EXCLUDED.error, failed_at = EXCLUDED.failed_at;
    `);

    const cancelling = await client.query<{
      state: string;
      ticket_cancellation_reconciled_version: number | null;
    }>(`
      SELECT state, ticket_cancellation_reconciled_version
      FROM active_runs
      WHERE subject_key = 'ticket:jira:AIW-1'
    `);
    expect(cancelling.rows).toEqual([
      { state: "cancelling", ticket_cancellation_reconciled_version: -1 },
    ]);

    // The old pod's matching release remains fail-closed: only a current
    // reconciler may bless the observed ticket version and release this row.
    await expect(
      client.query(`
        DELETE FROM active_runs
        WHERE subject_key = 'ticket:jira:AIW-1'
          AND owner_token = 'owner-a'
          AND run_id = 'run-a'
          AND state = 'cancelling'
        RETURNING subject_key
      `),
    ).rejects.toThrow(/cancellation has not been reconciled/i);
    const retained = await client.query<{ subject_key: string }>(`
      SELECT subject_key
      FROM active_runs
      WHERE subject_key = 'ticket:jira:AIW-1'
    `);
    expect(retained.rows).toEqual([{ subject_key: "ticket:jira:AIW-1" }]);

    await client.exec(`
      UPDATE active_runs
      SET ticket_cancellation_reconciled_version = ticket_mutation_version
      WHERE subject_key = 'ticket:jira:AIW-1';
      DELETE FROM active_runs
      WHERE subject_key = 'ticket:jira:AIW-1';
    `);

    const markers = await client.query<{
      ticket_key: string;
      run_id: string;
      error: string;
    }>(`
      SELECT ticket_key, run_id, error
      FROM failed_tickets
      ORDER BY ticket_key
    `);
    expect(markers.rows).toEqual([
      { ticket_key: "AIW-2", run_id: "run-b", error: "unrelated marker" },
    ]);
  });

  it("suppresses legacy writes whose run does not own the bound ticket", async () => {
    const client = await migrateThrough("0035");
    await client.exec(`
      INSERT INTO active_runs
        (subject_key, ticket_key, owner_token, run_id, state)
      VALUES ('ticket:jira:AIW-1', 'AIW-1', 'owner-a', 'run-a', 'bound');
      INSERT INTO failed_tickets (ticket_key, run_id, error, failed_at)
      VALUES ('AIW-1', 'run-stale', 'wrong run', '2026-07-19T12:00:00.000Z');
    `);

    const markers = await client.query(`SELECT * FROM failed_tickets`);
    expect(markers.rows).toEqual([]);
  });

  it("chains an unchanged schema snapshot from 0034", () => {
    const previous = JSON.parse(
      readFileSync(`${migrationsDir}meta/0034_snapshot.json`, "utf8"),
    ) as { id: string; tables: unknown };
    const current = JSON.parse(
      readFileSync(`${migrationsDir}meta/0035_snapshot.json`, "utf8"),
    ) as { prevId: string; tables: unknown };

    expect(current.prevId).toBe(previous.id);
    expect(current.tables).toEqual(previous.tables);
  });
});
