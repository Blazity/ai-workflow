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

async function primaryKeyColumns(
  client: PGlite,
  table: string,
): Promise<string[]> {
  const result = await client.query<{ column_name: string }>(
    `
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
       AND kcu.table_schema = tc.table_schema
      WHERE tc.table_schema = 'public'
        AND tc.table_name = $1
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position
    `,
    [table],
  );
  return result.rows.map((row) => row.column_name);
}

describe("0047 trigger rate limit migration", () => {
  it("keys the fixed-window counter on the window kind as well as its start", async () => {
    const client = await migrateThrough("0047");

    // window_start alone does not identify a window: at 00:00 UTC on the first
    // of a month minute, hour, day and month all floor to the same instant, so
    // the kind has to be part of the key or the four counters collide.
    await expect(primaryKeyColumns(client, "trigger_rate_limits")).resolves.toEqual([
      "definition_id",
      "node_id",
      "window_kind",
      "window_start",
    ]);
  });

  it("rejects a second row for the same node, kind and window, and accepts a different kind", async () => {
    const client = await migrateThrough("0047");
    const insert = (windowKind: string) =>
      client.query(
        `INSERT INTO trigger_rate_limits (definition_id, node_id, window_kind, window_start, count)
         VALUES ('7', 'trigger', $1, '2026-09-01T00:00:00Z', 1)`,
        [windowKind],
      );

    await insert("hour");
    // Same key: the constraint is what makes the upsert an atomic counter.
    await expect(insert("hour")).rejects.toThrow(/duplicate key/i);
    // Same instant, different kind: a row of its own.
    await expect(insert("day")).resolves.toBeDefined();

    const rows = await client.query<{ count: string }>(
      "SELECT count FROM trigger_rate_limits",
    );
    expect(rows.rows).toHaveLength(2);
  });

  it("keys the rejection counter per node, day and reason", async () => {
    const client = await migrateThrough("0047");

    await expect(
      primaryKeyColumns(client, "trigger_rejection_counters"),
    ).resolves.toEqual(["definition_id", "node_id", "day", "reason"]);
  });
});
