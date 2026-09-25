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

/** What a guarded reset did. `staleVersion` is set, and nothing was removed,
 *  when the key moved on since the caller read it. */
export interface SettingResetRow {
  removed: boolean;
  staleVersion: number | null;
}

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
 * `removed` is false when the key had no stored row. Nothing is written then,
 * and no version row either: the environment or the default was already
 * answering, so there is no decision to record.
 *
 * `expectedVersion` guards the delete in the same statement, as it guards a
 * patch: when the key's newest version row is no longer the one the caller
 * read (0 for none) and a row is still stored, somebody changed the value the
 * caller was looking at, and removing it would throw away a decision they
 * never saw. The row stays and `staleVersion` names the version it is at. A
 * key nobody stores any more is not stale: the outcome asked for already holds.
 */
export async function deleteSetting(
  db: Db,
  input: {
    key: string;
    resolvedValue: SettingValue;
    actor: string;
    reason: string;
    expectedVersion?: number;
  },
): Promise<SettingResetRow> {
  // The value rides as JSON text for the reason writeManySettings gives: a JSON
  // null through jsonb_to_recordset becomes SQL NULL and would be refused by the
  // not-null column, and a key whose resolved value is null is ordinary here.
  const resolved = JSON.stringify(input.resolvedValue ?? null);
  const expected = input.expectedVersion ?? null;
  const result = (await db.execute(sql`
    with latest as (
      select coalesce(max(${settingsVersions.id}), 0) as id
      from ${settingsVersions}
      where ${settingsVersions.key} = ${input.key}
    ), stale as (
      select latest.id as current_version
      from latest
      where ${expected}::bigint is not null
        and latest.id <> ${expected}::bigint
        and exists (select 1 from ${settings} where ${settings.key} = ${input.key})
    ), removed as (
      delete from ${settings}
      where ${settings.key} = ${input.key}
        and not exists (select 1 from stale)
      returning key, value
    ), recorded as (
      insert into ${settingsVersions} (key, previous_value, new_value, actor, reason)
      select removed.key, removed.value, ${resolved}::jsonb, ${input.actor}, ${input.reason}
      from removed
      returning id
    )
    select
      (select count(*) from recorded) as recorded,
      (select current_version from stale) as "staleVersion"
  `)) as ExecuteRows<{ recorded: number | string; staleVersion: number | string | null }>;
  const row = result.rows[0];
  return {
    removed: Number(row?.recorded ?? 0) > 0,
    staleVersion:
      row?.staleVersion === null || row?.staleVersion === undefined
        ? null
        : Number(row.staleVersion),
  };
}

/** Clear one stored setting on the deployment's own connection. */
export function deleteConnectedSetting(
  input: Parameters<typeof deleteSetting>[1],
): Promise<SettingResetRow> {
  return deleteSetting(getDb(), input);
}
