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

/** A key a guarded write refused, and the version it is at now. */
interface StaleSettingRow {
  key: string;
  currentVersion: number;
}

/** What a guarded write did: the rows it recorded, or, when any key was stale,
 *  nothing at all and the keys that were. */
export interface SettingsWriteOutcome {
  versions: SettingsVersionRow[];
  stale: StaleSettingRow[];
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
 *
 * `expectedVersions` guards the write in the same statement, so there is no
 * window between a check and the write it guards. A key is stale when its
 * newest version row is no longer the one the caller named (0 for none) AND
 * the value stored now differs from the one this write would store: somebody
 * else decided something else in between. One stale key refuses the whole
 * patch, and the answer names every stale key. Two writes landing in the same
 * instant still see the same snapshot and can both pass; the history keeps
 * both rows, so the rarer race is recorded rather than silent.
 */
export async function writeManySettings(
  db: Db,
  input: {
    patch: Readonly<Record<string, SettingValue>>;
    actor: string;
    reason: string;
    expectedVersions?: Readonly<Record<string, number>>;
  },
): Promise<SettingsWriteOutcome> {
  const entries = Object.entries(input.patch).map(([key, value]) => ({
    key,
    value: JSON.stringify(value ?? null),
    // Null for a key the caller did not name: that key is written
    // unconditionally, which is what a client without the token gets.
    expected: input.expectedVersions?.[key] ?? null,
  }));
  if (entries.length === 0) return { versions: [], stale: [] };

  const result = (await db.execute(sql`
    with input as (
      select entry.key, entry.value::jsonb as value, entry.expected
      from jsonb_to_recordset(${JSON.stringify(entries)}::jsonb)
        as entry(key text, value text, expected bigint)
    ), previous as (
      select ${settings.key} as key, ${settings.value} as value
      from ${settings}
      where ${settings.key} in (select key from input)
    ), latest as (
      select ${settingsVersions.key} as key, max(${settingsVersions.id}) as id
      from ${settingsVersions}
      where ${settingsVersions.key} in (select key from input)
      group by ${settingsVersions.key}
    ), stale as (
      select input.key, coalesce(latest.id, 0) as current_version
      from input
      left join latest on latest.key = input.key
      left join previous on previous.key = input.key
      where input.expected is not null
        and coalesce(latest.id, 0) <> input.expected
        and previous.value is distinct from input.value
    ), written as (
      insert into ${settings} (key, value, updated_at, updated_by)
      select input.key, input.value, now(), ${input.actor} from input
      where not exists (select 1 from stale)
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
      'recorded' as kind,
      id,
      key,
      previous_value as "previousValue",
      new_value as "newValue",
      actor,
      reason,
      created_at as "createdAt"
    from recorded
    union all
    select
      'stale' as kind,
      current_version as id,
      key,
      null,
      null,
      null,
      null,
      null
    from stale
    order by kind, key
  `)) as ExecuteRows<RawVersionRow & { kind: "recorded" | "stale" }>;
  const versions: SettingsVersionRow[] = [];
  const stale: StaleSettingRow[] = [];
  for (const row of result.rows) {
    if (row.kind === "stale") stale.push({ key: row.key, currentVersion: Number(row.id) });
    else versions.push(toVersionRow(row));
  }
  return { versions, stale };
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
): Promise<SettingsWriteOutcome> {
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
