import type { PgDatabase } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";

/**
 * Driver-agnostic database handle shared by repository tests and the DB tier.
 * This is deliberately separate from the production client singleton so
 * callers cannot reach the client merely to name the handle type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, typeof schema>;
