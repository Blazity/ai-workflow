import { sql } from "drizzle-orm";

/**
 * A code list as SQL literals, for a `check()` constraint that is written from
 * the same list the code types itself with.
 *
 * Literals, never parameters: an interpolated value serializes as `$1`, which
 * no migrator can execute (`.claude/rules/worker-database.md`). The values are
 * code constants, and quotes are doubled all the same.
 */
export function checkLiterals(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", "));
}
