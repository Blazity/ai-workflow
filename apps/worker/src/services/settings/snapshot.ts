/**
 * One resolved value per setting, read once and handed down synchronously.
 *
 * The store is asynchronous and the consumers are not: today's accessors
 * return values, not promises, and an accessor that silently started returning
 * a promise would read as truthy and flip a feature on. So an entry point (an
 * HTTP handler, a cron tick, the MCP transport, and a run at its start) loads
 * one snapshot and passes it down; nothing below awaits a setting.
 *
 * The resolution order itself (an ordinary stored row, then the registry
 * default; environment then default for a redeploy-owned key) lives in
 * `@shared/contracts`, not here. A run resolves its own snapshot at run start
 * from inside the engine, which ADR-001 forbids from importing a service, so
 * the rule has to sit in the package both tiers may import or it would exist
 * twice and drift. This file is the service-tier composition of it: read the
 * rows, hand in this deployment's environment.
 */
import {
  resolveSettingsSnapshot,
  type SettingsResolution,
  type SettingsSnapshot,
} from "@shared/contracts";
import { readAllConnectedSettings, readAllSettings } from "../../db/repositories/settings.js";
import type { Db } from "../../db/types.js";
import { settingsEnvironment } from "../../infra/settings-environment.js";

export type { SettingsResolution };

/**
 * The snapshot without touching the database.
 *
 * Registry defaults plus the three values this deployment must still read
 * from the environment. Used by test fixtures that do not open a database.
 */
export function settingsSnapshotFromEnvironment(): SettingsSnapshot {
  return resolveSettingsSnapshot(new Map(), settingsEnvironment).snapshot;
}

/**
 * The snapshot and its sources, stored rows included. One database read and no
 * transition write: H1 made every ordinary value durable, and H2 rejects the
 * retired variable names at boot.
 */
export async function loadSettingsResolution(): Promise<SettingsResolution> {
  const rows = await readAllConnectedSettings();
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  return resolveSettingsSnapshot(stored, settingsEnvironment);
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
 * It resolves the same way as the connected read without reaching for a
 * different database.
 */
export async function loadSettingsSnapshotOn(db: Db): Promise<SettingsSnapshot> {
  const rows = await readAllSettings(db);
  return resolveSettingsSnapshot(
    new Map(rows.map((row) => [row.key, row.value])),
    settingsEnvironment,
  ).snapshot;
}
