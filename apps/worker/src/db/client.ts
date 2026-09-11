import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema.js";
import type { Db } from "./types.js";

/**
 * Driver-agnostic database handle. `any` for the query-result HKT so both
 * the neon-http production driver and the pglite test driver are
 * assignable — adapters only use the query-builder surface, which is
 * identical across drivers.
 */
export type { Db } from "./types.js";

let _db: Db | null = null;

/**
 * Lazily-created singleton. neon() is fetch-based (no sockets, no pools),
 * so a module-level singleton is safe in serverless functions AND inside
 * Workflow DevKit step bundles (same constraint the Upstash REST client
 * satisfied).
 */
export function getDb(): Db {
  if (!_db) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("Invalid environment variables:\n  DATABASE_URL: Required");
    }
    _db = drizzle({ client: neon(databaseUrl), schema });
  }
  return _db;
}
