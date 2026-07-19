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

describe("0029 active-run clarification parking migration", () => {
  it("adds parking and parked states while preserving exact run lineage", async () => {
    const client = await migrateThrough("0028");
    await client.exec(`
      INSERT INTO active_runs
        (subject_key, ticket_key, owner_token, run_id, state)
      VALUES
        ('ticket:jira:AIW-1', 'AIW-1', 'owner-bound', 'run-1', 'bound');
    `);

    await client.exec(
      readFileSync(`${migrationsDir}${migrationFile("0029")}`, "utf8"),
    );
    await client.exec(`
      UPDATE active_runs SET state = 'parking' WHERE owner_token = 'owner-bound';
      UPDATE active_runs SET state = 'parked' WHERE owner_token = 'owner-bound';
    `);

    const result = await client.query<{ state: string; run_id: string | null }>(`
      SELECT state, run_id FROM active_runs WHERE owner_token = 'owner-bound'
    `);
    expect(result.rows).toEqual([{ state: "parked", run_id: "run-1" }]);

    await expect(
      client.exec(`
        INSERT INTO active_runs
          (subject_key, ticket_key, owner_token, run_id, state)
        VALUES
          ('ticket:jira:AIW-2', 'AIW-2', 'invalid-parked', NULL, 'parked');
      `),
    ).rejects.toThrow();
  });

  it("chains its snapshot from 0028 with parking-aware constraints", () => {
    type Snapshot = {
      id: string;
      prevId: string;
      tables: Record<
        string,
        { checkConstraints?: Record<string, { name: string; value: string }> }
      >;
    };
    const previous = JSON.parse(
      readFileSync(`${migrationsDir}meta/0028_snapshot.json`, "utf8"),
    ) as Snapshot;
    const current = JSON.parse(
      readFileSync(`${migrationsDir}meta/0029_snapshot.json`, "utf8"),
    ) as Snapshot;

    expect(current.prevId).toBe(previous.id);
    expect(current.tables["public.active_runs"]?.checkConstraints).toMatchObject({
      active_runs_state_check: {
        value:
          `"active_runs"."state" in (` +
          `'reserved', 'bound', 'parking', 'parked', 'cancelling')`,
      },
      active_runs_state_run_id_check: {
        value:
          `("active_runs"."state" = 'reserved' and "active_runs"."run_id" is null) or ` +
          `("active_runs"."state" in ('bound', 'parking', 'parked') and ` +
          `"active_runs"."run_id" is not null) or "active_runs"."state" = 'cancelling'`,
      },
    });
  });
});
