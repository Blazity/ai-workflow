/**
 * Paging one setting's recorded changes.
 *
 * Its own file for the reason `settings-reset.ts` is: it arrived with the MCP
 * parity stage while the catalog stage owned `settings.ts`, and a later change
 * may fold them together.
 *
 * Only the connected half is exported, for the reason its sibling gives.
 *
 * `settings.ts` already lists versions with a limit. What it cannot do is say
 * whether older changes exist, which is the difference between "this is the
 * history" and "this is the newest page of it".
 */
import { and, desc, eq, lt } from "drizzle-orm";
import { getDb, type Db } from "../client.js";
import { settingsVersions } from "../schema.js";

/**
 * One page of a key's changes, newest first.
 *
 * `before` is a version ROW id, not an offset: version rows are append-only, so
 * "older than this id" is stable while somebody else is writing, where an
 * offset would repeat or skip a row.
 */
function listSettingsVersionPageRows(
  db: Db,
  input: { key: string; limit: number; before?: number },
) {
  const olderThan =
    input.before === undefined ? undefined : lt(settingsVersions.id, input.before);
  return db
    .select()
    .from(settingsVersions)
    .where(
      olderThan === undefined
        ? eq(settingsVersions.key, input.key)
        : and(eq(settingsVersions.key, input.key), olderThan),
    )
    .orderBy(desc(settingsVersions.id))
    .limit(input.limit);
}

export function listConnectedSettingsVersionPageRows(input: {
  key: string;
  limit: number;
  before?: number;
}) {
  return listSettingsVersionPageRows(getDb(), input);
}
