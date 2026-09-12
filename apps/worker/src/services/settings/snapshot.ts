/**
 * One resolved value per setting, read once and handed down synchronously.
 *
 * The store is asynchronous and the consumers are not: today's accessors
 * return values, not promises, and an accessor that silently started returning
 * a promise would read as truthy and flip a feature on. So an entry point (an
 * HTTP handler, a cron tick, the MCP transport, and a run at its start) loads
 * one snapshot and passes it down; nothing below awaits a setting.
 *
 * The resolution order itself (the stored row, then the value the deployment's
 * environment already resolved to, then the registry default) lives in
 * `@shared/contracts`, not here. A run resolves its own snapshot at run start
 * from inside the engine, which ADR-001 forbids from importing a service, so
 * the rule has to sit in the package both tiers may import or it would exist
 * twice and drift. This file is the service-tier composition of it: read the
 * rows, hand in this deployment's environment.
 */
import {
  resolveSettingsSnapshot,
  type SettingsResolution,
  type SettingsSeedRow,
  type SettingsSnapshot,
  settingsSeedRowsFrom,
} from "@shared/contracts";
import { readAllConnectedSettings, readAllSettings } from "../../db/repositories/settings.js";
import type { Db } from "../../db/types.js";
import { settingsEnvironment } from "../../infra/settings-environment.js";
import { ensureEnvironmentSettingsImported } from "./environment-import.js";

export type { SettingsResolution, SettingsSeedRow };

/**
 * The snapshot without touching the database.
 *
 * The transition fallback: every accessor that has not been handed a snapshot
 * yet resolves through this, so a caller converted in a later stage and one
 * that is not both see the same value on a deployment with an empty table.
 */
export function settingsSnapshotFromEnvironment(): SettingsSnapshot {
  return resolveSettingsSnapshot(new Map(), settingsEnvironment).snapshot;
}

/**
 * The snapshot and its sources, stored rows included. One database read.
 *
 * The environment import runs first, once per process: every value this
 * deployment resolves from a variable that is about to be deleted becomes a
 * stored row before anything reads one, so the rows below already include it.
 * It writes nothing after the first call, and a failure only logs, so the
 * resolution order still answers from the environment either way.
 */
export async function loadSettingsResolution(): Promise<SettingsResolution> {
  await ensureEnvironmentSettingsImported();
  const rows = await readAllConnectedSettings();
  return resolveSettingsSnapshot(
    new Map(rows.map((row) => [row.key, row.value])),
    settingsEnvironment,
  );
}

/** The snapshot one entry point loads and hands down. One database read. */
export async function loadSettingsSnapshot(): Promise<SettingsSnapshot> {
  return (await loadSettingsResolution()).snapshot;
}

/**
 * The same snapshot, from a connection the caller holds.
 *
 * The db-bound half of every service pair in this repository (`operation(db,
 * input)` beside `operationConnected(input)`) exists so a test, a migration or
 * a harness can run the same code against its own database. A settings read
 * that reached for the deployment's own connection from inside one of those
 * would answer from a different database than everything around it, and on a
 * machine with no `DATABASE_URL` it would not answer at all.
 *
 * It deliberately does NOT run the environment import: that is a one-off write
 * this deployment makes to its own store, not something a caller's connection
 * should have done to it.
 */
export async function loadSettingsSnapshotOn(db: Db): Promise<SettingsSnapshot> {
  const rows = await readAllSettings(db);
  return resolveSettingsSnapshot(
    new Map(rows.map((row) => [row.key, row.value])),
    settingsEnvironment,
  ).snapshot;
}

/**
 * The rows the build-time seed writes: one per key whose variable this
 * deployment actually sets, carrying the value the environment already
 * resolved to. A key with no variable, and a variable left unset, produce no
 * row, so the resolution order keeps answering for them.
 */
export function settingsSeedRows(): SettingsSeedRow[] {
  return settingsSeedRowsFrom(settingsEnvironment);
}
