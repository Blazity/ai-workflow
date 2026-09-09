import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "./schema.js";
import type { Db } from "./client.js";

const migrationDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));

let migrationSql: string[] | null = null;

function migrations(): string[] {
  migrationSql ??= readdirSync(migrationDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(`${migrationDir}${f}`, "utf8"));
  return migrationSql;
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * The statement that returns a migrated database to the state the migrations
 * left it in, derived from that state rather than from a hardcoded list so a
 * future seeding migration is picked up on its own.
 *
 * Truncating alone would not do: 0013 seeds a `workflow_definitions` row and
 * 0021 seeds the built-in `prompt_library` entries, and further migrations
 * derive from them, so an empty database is not what callers have been handed.
 * The seeded rows are copied into a private schema once and re-inserted
 * parent-before-child, because `workflow_definition_triggers` carries a
 * foreign key into `workflow_definitions`. Identity sequences are then moved
 * past the restored rows so the next insert cannot collide with the seed.
 */
async function buildReset(client: PGlite): Promise<string> {
  const tables = (
    await client.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename",
    )
  ).rows.map((r) => r.tablename);

  const seeded: string[] = [];
  for (const table of tables) {
    const { rows } = await client.query<{ count: number }>(
      `select count(*)::int as count from ${quote(table)}`,
    );
    if (rows[0] && rows[0].count > 0) seeded.push(table);
  }

  const edges = (
    await client.query<{ child: string; parent: string }>(
      `select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent
       from pg_constraint c where c.contype = 'f'`,
    )
  ).rows
    .map(({ child, parent }) => [strip(child), strip(parent)] as const)
    .filter(([child, parent]) => child !== parent && seeded.includes(child) && seeded.includes(parent));

  const restoreOrder: string[] = [];
  const pending = new Set(seeded);
  while (pending.size > 0) {
    const ready = [...pending].filter((t) => !edges.some(([c, p]) => c === t && pending.has(p)));
    // A cycle would leave nothing ready; emit the rest and let the foreign key
    // speak for itself rather than looping forever.
    const next = ready.length > 0 ? ready : [...pending];
    for (const table of next) {
      restoreOrder.push(table);
      pending.delete(table);
    }
  }

  await client.exec("create schema if not exists _seed;");
  for (const table of restoreOrder) {
    await client.exec(
      `create table _seed.${quote(table)} as select * from public.${quote(table)};`,
    );
  }

  const sequences = (
    await client.query<{ table_name: string; column_name: string; sequence: string | null }>(
      `select table_name, column_name,
              pg_get_serial_sequence('public.' || quote_ident(table_name), column_name) as sequence
       from information_schema.columns
       where table_schema = 'public' and column_default like 'nextval%'`,
    )
  ).rows.filter((r) => r.sequence !== null && seeded.includes(r.table_name));

  return [
    `truncate table ${tables.map(quote).join(",")} restart identity cascade;`,
    ...restoreOrder.map(
      (t) => `insert into public.${quote(t)} select * from _seed.${quote(t)};`,
    ),
    ...sequences.map(
      (r) =>
        `select setval('${r.sequence}', coalesce((select max(${quote(r.column_name)}) from public.${quote(r.table_name)}), 1));`,
    ),
  ].join("");
}

function strip(regclass: string): string {
  return regclass.replace(/^public\./, "").replace(/"/g, "");
}

let shared: { client: PGlite; db: Db; reset: string } | null = null;

/**
 * In-memory Postgres for unit tests. Applies the committed drizzle/
 * migration SQL so tests run against the exact production schema —
 * uniqueness conflicts, array ops, and expiry filters behave for real
 * instead of being mocked.
 *
 * One instance per module registry, which under vitest's default isolation is
 * one per test file, reset in place on every later call. Booting PGlite costs
 * around 500 ms while resetting costs around 27 ms, and 83 test files call
 * this from `beforeEach`, so the boot was the entire price: roughly 1568 of
 * them per suite run, none of which produced a different schema than the one
 * before it.
 */
export async function createTestDb(): Promise<Db> {
  if (!shared) {
    const client = new PGlite();
    for (const sql of migrations()) await client.exec(sql);
    const reset = await buildReset(client);
    shared = { client, db: drizzle({ client, schema }) as unknown as Db, reset };
    return shared.db;
  }
  await shared.client.exec(shared.reset);
  return shared.db;
}
