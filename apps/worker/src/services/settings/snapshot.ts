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
import {
  ensureEnvironmentSettingsImported,
  migratedVariablesSet,
  migratedVariablesUnstored,
} from "./environment-import.js";

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
 * The snapshot and its sources, stored rows included. One database read, plus
 * one write on the single read of a process that finds something missing.
 *
 * The rows come first and the import second, which is the order that lets this
 * tell the truth. Knowing what is stored is what decides what is missing, so
 * the statement is sent for those keys only and a settled deployment issues
 * none at all; and because the rows are read before anything is written, the
 * "is this value safe to remove the variable for" question is answered by the
 * table rather than by an import having once believed it succeeded.
 *
 * What that one import writes is folded in rather than read back, because those
 * rows carry the values this same resolution just sent and a second query would
 * ask the database to confirm what it was told a moment ago. It is folded in
 * once, by this call: the import hands its rows over and forgets them, so every
 * later resolution answers from the table alone and a key reset in the same
 * process stops claiming to be stored. A failed import writes nothing, folds in
 * nothing, and leaves its keys resolving from the environment and named in
 * `migratedVariablesUnstored`.
 */
export async function loadSettingsResolution(): Promise<SettingsResolution> {
  const rows = await readAllConnectedSettings();
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  for (const row of await ensureEnvironmentSettingsImported(new Set(stored.keys()))) {
    stored.set(row.key, row.value);
  }
  return resolveSettingsSnapshot(stored, settingsEnvironment);
}

/** What this deployment still owes the settings migration, both halves. */
export interface MigratedVariablesStatus {
  /** Every migrated variable this deployment still sets, by name. */
  readonly set: string[];
  /** Those of them no stored row answers for yet, by name. Empty is the
   *  condition the cleanup release waits for. */
  readonly unstored: string[];
}

/**
 * Both lists, from one resolution.
 *
 * The pair is asked for by `/health`, by the Settings page and by the MCP
 * surface, and asking separately would let the two halves come from two reads
 * and disagree about the same moment.
 */
export async function migratedVariablesStatus(): Promise<MigratedVariablesStatus> {
  const resolution = await loadSettingsResolution();
  return {
    set: migratedVariablesSet(),
    unstored: migratedVariablesUnstored(resolution),
  };
}

/**
 * The same pair, read only: one query, no import, nothing written.
 *
 * `/health` is public and unauthenticated, and answering it must never write:
 * a request nobody authenticated would otherwise be able to make this process
 * store rows, and the endpoint's whole job is to keep answering on a
 * deployment that is already in trouble. The values are the same as the pair
 * above on any deployment whose import has run, and on one where it has not
 * this answers the honest thing: those variables are not stored yet.
 */
export async function migratedVariablesStatusReadOnly(): Promise<MigratedVariablesStatus> {
  const rows = await readAllConnectedSettings();
  const resolution = resolveSettingsSnapshot(
    new Map(rows.map((row) => [row.key, row.value])),
    settingsEnvironment,
  );
  return {
    set: migratedVariablesSet(),
    unstored: migratedVariablesUnstored(resolution),
  };
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
