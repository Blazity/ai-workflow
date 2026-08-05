import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "./schema.js";
import type { Db } from "./client.js";

// Postgres does not WAL-log every nextval(): it logs a value SEQ_LOG_VALS
// (32) increments ahead and serves the in-between values from memory. A
// data directory restored via loadDataDir resumes each sequence from that
// logged high-water mark, not its true last value, so ids jump ahead of
// where a plain migration replay would leave them. Reset every sequence to
// max(column) + 1 so inserts after a restore get the same ids they would
// after a fresh migration replay.
const RESET_SEQUENCES_SQL = `
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT s.relname AS seq, t.relname AS tbl, a.attname AS col
    FROM pg_class s
    JOIN pg_depend d ON d.objid = s.oid
      AND d.classid = 'pg_class'::regclass
      AND d.refclassid = 'pg_class'::regclass
    JOIN pg_class t ON t.oid = d.refobjid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
    WHERE s.relkind = 'S'
  LOOP
    EXECUTE format(
      'SELECT setval(%L, COALESCE((SELECT MAX(%I) FROM %I), 0) + 1, false)',
      r.seq, r.col, r.tbl
    );
  END LOOP;
END $$;
`;

/**
 * In-memory Postgres for unit tests. The first call in a process applies
 * the committed drizzle/ migration SQL to build the exact production
 * schema, then caches a snapshot of that empty database. Every later call
 * restores a fresh, independent instance from the cached snapshot and
 * resets its sequences to match, so tests still run against the exact
 * production schema (uniqueness conflicts, array ops, and expiry filters
 * behave for real instead of being mocked) without paying the migration
 * cost on every call.
 */
let dataDirDump: Promise<Blob> | undefined;

async function buildDataDir(): Promise<Blob> {
  const client = new PGlite();
  const dir = fileURLToPath(new URL("../../drizzle/", import.meta.url));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    await client.exec(readFileSync(`${dir}${f}`, "utf8"));
  }
  try {
    return await client.dumpDataDir();
  } finally {
    await client.close();
  }
}

export async function createTestDb(): Promise<Db> {
  if (!dataDirDump) {
    dataDirDump = buildDataDir();
  }
  const client = new PGlite({ loadDataDir: await dataDirDump });
  await client.exec(RESET_SEQUENCES_SQL);
  return drizzle({ client, schema }) as unknown as Db;
}
