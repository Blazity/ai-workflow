import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "./schema.js";
import type { Db } from "./client.js";

/**
 * In-memory Postgres for unit tests. Applies the committed drizzle/
 * migration SQL so tests run against the exact production schema —
 * uniqueness conflicts, array ops, and expiry filters behave for real
 * instead of being mocked.
 */
export async function createTestDb(): Promise<Db> {
  const client = new PGlite();
  const dir = fileURLToPath(new URL("../../drizzle/", import.meta.url));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    await client.exec(readFileSync(`${dir}${f}`, "utf8"));
  }
  return drizzle({ client, schema }) as unknown as Db;
}
