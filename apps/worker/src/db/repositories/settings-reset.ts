/**
 * Clearing one stored setting, so the environment or the registry default
 * answers for it again.
 *
 * Its own file rather than a function appended to `settings.ts`: it arrived
 * with the MCP parity stage while the catalog stage owned that file, and a
 * later change may fold the two together. Nothing here is a second way to do
 * what `writeManySettings` does -- storing a value and removing the row that
 * holds one are different statements and different history rows.
 *
 * Production uses neon-http and cannot open an interactive transaction, so the
 * delete and the version row that records it travel as ONE data-modifying CTE:
 * a crash can leave both written or neither, never a cleared setting with no
 * record of who cleared it.
 */
import { sql } from "drizzle-orm";
import type { SettingValue } from "@shared/contracts";
import { getDb, type Db } from "../client.js";
import { settings, settingsVersions } from "../schema.js";

type ExecuteRows<T> = { rows: T[] };

/**
 * Remove one stored setting and record the clearing.
 *
 * `resolvedValue` is what the key resolves to once the row is gone, computed by
 * the caller from the resolution order, and it is what the version row stores
 * as `newValue`. Recording the registry default instead would be a lie on every
 * deployment whose environment sets the variable, and recording null would say
 * "this setting is deliberately cleared", which is the one thing this operation
 * does NOT do: it hands the key back rather than pinning it to nothing.
 *
 * Returns false when the key had no stored row. Nothing is written then, and no
 * version row either: the environment or the default was already answering, so
 * there is no decision to record.
 */
export async function deleteSetting(
  db: Db,
  input: {
    key: string;
    resolvedValue: SettingValue;
    actor: string;
    reason: string;
  },
): Promise<boolean> {
  // The value rides as JSON text for the reason writeManySettings gives: a JSON
  // null through jsonb_to_recordset becomes SQL NULL and would be refused by the
  // not-null column, and a key whose resolved value is null is ordinary here.
  const resolved = JSON.stringify(input.resolvedValue ?? null);
  const result = (await db.execute(sql`
    with removed as (
      delete from ${settings}
      where ${settings.key} = ${input.key}
      returning key, value
    ), recorded as (
      insert into ${settingsVersions} (key, previous_value, new_value, actor, reason)
      select removed.key, removed.value, ${resolved}::jsonb, ${input.actor}, ${input.reason}
      from removed
      returning id
    )
    select id from recorded
  `)) as ExecuteRows<{ id: number | string }>;
  return result.rows.length > 0;
}

/** Clear one stored setting on the deployment's own connection. */
export function deleteConnectedSetting(
  input: Parameters<typeof deleteSetting>[1],
): Promise<boolean> {
  return deleteSetting(getDb(), input);
}
