import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { env } from "../../env.js";
import * as schema from "./schema.js";

/**
 * Driver-agnostic database handle. `any` for the query-result HKT so both
 * the neon-http production driver and the pglite test driver are
 * assignable — adapters only use the query-builder surface, which is
 * identical across drivers.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, typeof schema>;

let _db: Db | null = null;

/**
 * Lazily-created singleton. neon() is fetch-based (no sockets, no pools),
 * so a module-level singleton is safe in serverless functions AND inside
 * Workflow DevKit step bundles (same constraint the Upstash REST client
 * satisfied).
 */
export function getDb(): Db {
  if (!_db) {
    _db = drizzle({ client: neon(env.DATABASE_URL), schema });
  }
  return _db;
}
