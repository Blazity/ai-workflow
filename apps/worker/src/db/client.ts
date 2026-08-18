import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { env } from "../../env.js";
import * as schema from "./schema.js";

/**
 * Driver-agnostic database handle. `any` for the query-result HKT so both
 * the node-postgres production driver and the pglite test driver are
 * assignable — adapters only use the query-builder surface, which is
 * identical across drivers.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, typeof schema>;

let _pool: Pool | null = null;
let _db: Db | null = null;

/**
 * Lazily-created singleton over a node-postgres Pool. The Pool is a
 * module-level singleton reused across invocations (mirroring the old
 * fetch-client memoization), so a warm instance opens its TCP connections
 * once and hands them back to the pool between invocations.
 *
 * Connection-count math on Vercel Fluid Compute: many warm instances can be
 * live at once and each keeps its OWN pool, so the ceiling of live TCP
 * connections is `max` × (warm instances). Keep `max` small (3) so a burst of
 * warm instances cannot exhaust the Postgres/pooler connection budget, while
 * still leaving a few connections for the several invocations Fluid runs
 * concurrently inside one instance. Idle clients are dropped after 10s so a
 * warm-but-idle instance stops holding connections between bursts, and a
 * connection that cannot be acquired fails within 10s rather than hanging.
 *
 * Both Neon and Railway require TLS. `rejectUnauthorized: false` keeps the
 * handshake encrypted without shipping a CA bundle (there is no CA convention
 * in this repo); a Neon `sslmode=require` URL still connects.
 */
export function getDb(): Db {
  if (!_db) {
    _pool = new Pool({
      connectionString: env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    _db = drizzle({ client: _pool, schema });
  }
  return _db;
}
