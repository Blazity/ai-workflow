import { desc, eq, sql } from "drizzle-orm";
import type { SettingValue } from "@shared/contracts";
import { getDb, type Db } from "../client.js";
import { settings, settingsVersions } from "../schema.js";

/** One stored decision, exactly as the table holds it. */
export interface SettingRow {
  key: string;
  value: SettingValue;
  updatedAt: Date;
  updatedBy: string;
}

/** One recorded change. */
export interface SettingsVersionRow {
  id: number;
  key: string;
  previousValue: SettingValue;
  newValue: SettingValue;
  actor: string;
  reason: string;
  createdAt: Date;
}

type ExecuteRows<T> = { rows: T[] };

type RawVersionRow = {
  id: number | string;
  key: string;
  previousValue: SettingValue;
  newValue: SettingValue;
  actor: string;
  reason: string;
  createdAt: string | Date;
};

/**
 * Raw `execute` gives back whatever the driver decided: neon-http hands
 * timestamps over as strings and identity columns as numbers or strings
 * depending on the type, while pglite parses both. Normalizing here keeps the
 * difference from reaching a caller that only ever ran against one of them.
 */
function toVersionRow(row: RawVersionRow): SettingsVersionRow {
  return {
    id: Number(row.id),
    key: row.key,
    previousValue: row.previousValue ?? null,
    newValue: row.newValue,
    actor: row.actor,
    reason: row.reason,
    createdAt: new Date(row.createdAt),
  };
}

/** Every stored setting. Absence of a key is meaningful, so nothing is filled in here. */
export async function readAllSettings(db: Db): Promise<SettingRow[]> {
  const rows = await db.select().from(settings);
  return rows.map((row) => ({
    key: row.key,
    value: row.value,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  }));
}

/**
 * Apply a patch and record what it changed, in one statement.
 *
 * Production uses neon-http and cannot open an interactive transaction, so the
 * settings rows and their version rows travel as one data-modifying CTE: a
 * crash can leave both written or neither, never a changed setting with no
 * record of who changed it.
 *
 * The values ride as JSON text rather than as jsonb fields because
 * `jsonb_to_recordset` turns a JSON null into SQL NULL, which would refuse the
 * not-null column instead of storing "this setting is deliberately cleared".
 *
 * A key whose stored value already equals the new one is skipped by the
 * conflict clause, so the history holds decisions rather than form
 * submissions, and a key with no row yet is always recorded even when its
 * value matches what the environment was already resolving to: the decision
 * being recorded is "this is now stored", not "this number changed".
 */
export async function writeManySettings(
  db: Db,
  input: {
    patch: Readonly<Record<string, SettingValue>>;
    actor: string;
    reason: string;
  },
): Promise<SettingsVersionRow[]> {
  const entries = Object.entries(input.patch).map(([key, value]) => ({
    key,
    value: JSON.stringify(value ?? null),
  }));
  if (entries.length === 0) return [];

  const result = (await db.execute(sql`
    with input as (
      select entry.key, entry.value::jsonb as value
      from jsonb_to_recordset(${JSON.stringify(entries)}::jsonb)
        as entry(key text, value text)
    ), previous as (
      select ${settings.key} as key, ${settings.value} as value
      from ${settings}
      where ${settings.key} in (select key from input)
    ), written as (
      insert into ${settings} (key, value, updated_at, updated_by)
      select input.key, input.value, now(), ${input.actor} from input
      on conflict (key) do update
        set value = excluded.value,
            updated_at = excluded.updated_at,
            updated_by = excluded.updated_by
        where ${settings}.value is distinct from excluded.value
      returning key, value
    ), recorded as (
      insert into ${settingsVersions} (key, previous_value, new_value, actor, reason)
      select written.key, previous.value, written.value, ${input.actor}, ${input.reason}
      from written left join previous on previous.key = written.key
      returning id, key, previous_value, new_value, actor, reason, created_at
    )
    select
      id,
      key,
      previous_value as "previousValue",
      new_value as "newValue",
      actor,
      reason,
      created_at as "createdAt"
    from recorded
    order by key
  `)) as ExecuteRows<RawVersionRow>;
  return result.rows.map(toVersionRow);
}

/** One key's history, newest first. */
export async function listSettingsVersions(
  db: Db,
  key: string,
  limit: number,
): Promise<SettingsVersionRow[]> {
  const rows = await db
    .select()
    .from(settingsVersions)
    .where(eq(settingsVersions.key, key))
    .orderBy(desc(settingsVersions.id))
    .limit(limit);
  return rows.map(toVersionRow);
}

/**
 * The newest version row of every key that has one.
 *
 * `distinct on` rather than one query per key: the read response names the
 * last change of every setting, and a deployment with thirty-seven of them
 * should not pay thirty-seven round trips for it.
 */
export async function latestSettingsVersions(db: Db): Promise<SettingsVersionRow[]> {
  const result = (await db.execute(sql`
    select distinct on (key)
      id,
      key,
      previous_value as "previousValue",
      new_value as "newValue",
      actor,
      reason,
      created_at as "createdAt"
    from ${settingsVersions}
    order by key, id desc
  `)) as ExecuteRows<RawVersionRow>;
  return result.rows.map(toVersionRow);
}

/** Every stored setting, on the deployment's own connection. */
export function readAllConnectedSettings(): Promise<SettingRow[]> {
  return readAllSettings(getDb());
}

/** Apply a patch on the deployment's own connection. */
export function writeManyConnectedSettings(
  input: Parameters<typeof writeManySettings>[1],
): Promise<SettingsVersionRow[]> {
  return writeManySettings(getDb(), input);
}

/** One key's history, on the deployment's own connection. */
export function listConnectedSettingsVersions(
  key: string,
  limit: number,
): Promise<SettingsVersionRow[]> {
  return listSettingsVersions(getDb(), key, limit);
}

/** The newest change per key, on the deployment's own connection. */
export function latestConnectedSettingsVersions(): Promise<SettingsVersionRow[]> {
  return latestSettingsVersions(getDb());
}
