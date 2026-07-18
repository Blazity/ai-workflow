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

describe("0027 active-run cancellation migration", () => {
  it("allows cancelling reserved and bound owners while preserving their run lineage", async () => {
    const client = await migrateThrough("0026");
    await client.exec(`
      INSERT INTO active_runs
        (subject_key, ticket_key, owner_token, run_id, state)
      VALUES
        ('ticket:jira:AIW-1', 'AIW-1', 'owner-reserved', NULL, 'reserved'),
        ('ticket:jira:AIW-2', 'AIW-2', 'owner-bound', 'run-2', 'bound');
    `);

    await client.exec(
      readFileSync(`${migrationsDir}0027_tired_ezekiel.sql`, "utf8"),
    );
    await client.exec(`
      UPDATE active_runs
      SET state = 'cancelling'
      WHERE owner_token IN ('owner-reserved', 'owner-bound');
    `);

    const cancelling = await client.query<{
      owner_token: string;
      run_id: string | null;
      state: string;
    }>(`
      SELECT owner_token, run_id, state
      FROM active_runs
      ORDER BY owner_token
    `);
    expect(cancelling.rows).toEqual([
      { owner_token: "owner-bound", run_id: "run-2", state: "cancelling" },
      { owner_token: "owner-reserved", run_id: null, state: "cancelling" },
    ]);

    await expect(
      client.exec(`
        INSERT INTO active_runs
          (subject_key, ticket_key, owner_token, run_id, state)
        VALUES
          ('ticket:jira:AIW-3', 'AIW-3', 'invalid-reserved', 'run-3', 'reserved');
      `),
    ).rejects.toThrow();
    await expect(
      client.exec(`
        INSERT INTO active_runs
          (subject_key, ticket_key, owner_token, run_id, state)
        VALUES
          ('ticket:jira:AIW-4', 'AIW-4', 'invalid-bound', NULL, 'bound');
      `),
    ).rejects.toThrow();
  });

  it("chains its snapshot from 0026 with the upgraded state constraints", () => {
    type Snapshot = {
      id: string;
      prevId: string;
      tables: Record<
        string,
        {
          checkConstraints?: Record<string, { name: string; value: string }>;
        }
      >;
    };
    const previous = JSON.parse(
      readFileSync(`${migrationsDir}meta/0026_snapshot.json`, "utf8"),
    ) as Snapshot;
    const current = JSON.parse(
      readFileSync(`${migrationsDir}meta/0027_snapshot.json`, "utf8"),
    ) as Snapshot;

    expect(current.prevId).toBe(previous.id);
    expect(
      current.tables["public.active_runs"]?.checkConstraints,
    ).toMatchObject({
      active_runs_state_check: {
        value: `"active_runs"."state" in ('reserved', 'bound', 'cancelling')`,
      },
      active_runs_state_run_id_check: {
        value:
          `("active_runs"."state" = 'reserved' and "active_runs"."run_id" is null) or ` +
          `("active_runs"."state" = 'bound' and "active_runs"."run_id" is not null) or ` +
          `"active_runs"."state" = 'cancelling'`,
      },
    });
  });
});
