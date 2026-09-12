/**
 * Making this deployment's environment values durable, once, so the variables
 * can be removed.
 *
 * The cleanup stage deletes the environment parsing for every migrated key.
 * That deletion is only safe once every value a deployment currently runs on
 * exists as a stored row, and the build-time seed is not enough on its own: it
 * runs in the build step, so a deployment that upgraded before the seed
 * existed, a database restored from before it, or a build that skipped it for
 * want of `DATABASE_URL` all leave a deployment resolving live values from
 * variables that are about to disappear. This is the belt for that brace: the
 * first settings read of a process writes the missing rows and then never
 * looks again.
 *
 * Three rules decide what it writes, and each one is a decision somebody could
 * reasonably have made the other way:
 *
 * - A key that already has a stored row is never touched, even when the
 *   environment says something else. The row is the operator's decision and the
 *   variable is the thing being retired, so the row wins by definition. The
 *   caller hands in the rows it just read and only the missing keys are sent,
 *   so a deployment with nothing missing issues no statement at all.
 * - A key whose environment value equals the registry default is imported all
 *   the same. The point is not the number, it is that the number stops
 *   depending on a variable nobody will set again.
 * - A key marked `requiresRedeploy` is not imported at all: the deployment
 *   still reads that variable itself, so a stored row would be a second answer
 *   to the same question rather than a durable one, and the resolution ignores
 *   such a row anyway.
 *
 * It runs at the first snapshot rather than at boot because the module graph is
 * loaded before a request exists, and a database read on import is what makes a
 * cold start fail in a place nobody can see.
 *
 * What it writes is never the evidence that a value is safe. Whether a variable
 * can be removed is answered by reading the rows back (`migratedVariablesUnstored`
 * below), because a write that failed, a database restored behind the process
 * or a row somebody deleted are all states this module would otherwise report
 * as "stored" on the strength of having once tried.
 */
import {
  migratedVariablesSetIn,
  migratedVariablesUnstoredIn,
  redeployOwnedSettingRows,
  settingsSeedRowsFrom,
  type SettingsEnvironmentReader,
  type SettingsResolution,
  type SettingsSeedRow,
} from "@shared/contracts";
import { importConnectedEnvironmentSettings } from "../../db/repositories/settings.js";
import { logger } from "../../infra/logger.js";
import { settingsEnvironment } from "../../infra/settings-environment.js";

/** The actor a row imported from the environment is recorded under. Not a
 *  person and not "environment", which the build-time seed already uses: the
 *  history has to tell an operator which of the two wrote a row. */
const IMPORT_ACTOR = "environment import";

/** The reason on every version row this writes. */
const IMPORT_REASON =
  "Stored from the deployment environment so the variable can be removed.";

/** The reason on every version row this writes for a row it removes. */
const DISCARD_REASON =
  "Removed by the environment import: this key is read from the deployment environment, so a stored row was never in force.";

/** Writes the rows and returns the keys it created. Injected so a test can
 *  drive the decision without a database. */
type ImportWriter = (input: {
  rows: readonly SettingsSeedRow[];
  actor: string;
  reason: string;
  discarded?: { rows: readonly SettingsSeedRow[]; reason: string };
}) => Promise<string[]>;

/**
 * Store every migrated value this deployment resolves from its environment and
 * has no row for, and answer with the rows actually created.
 *
 * The caller passes the keys it just read, so the statement is sent only for
 * what is genuinely missing and a settled deployment pays nothing. The rows
 * come back rather than the key names alone so the caller can fold them into
 * the snapshot it is resolving instead of paying a second read for values it
 * already knows.
 */
export async function storeEnvironmentValues(
  storedKeys: ReadonlySet<string>,
  environment: SettingsEnvironmentReader = settingsEnvironment,
  write: ImportWriter = importConnectedEnvironmentSettings,
): Promise<SettingsSeedRow[]> {
  const missing = settingsSeedRowsFrom(environment).filter(
    (row) => !storedKeys.has(row.key),
  );
  // A row for a key the environment owns is ignored by the resolution, so it
  // is a value on the Settings page that nothing acts on. Only the ones that
  // exist are sent, which is what keeps a settled deployment at zero
  // statements.
  const discarded = redeployOwnedSettingRows(environment).filter((row) =>
    storedKeys.has(row.key),
  );
  if (missing.length === 0 && discarded.length === 0) return [];
  const written = await write({
    rows: missing,
    actor: IMPORT_ACTOR,
    reason: IMPORT_REASON,
    discarded: { rows: discarded, reason: DISCARD_REASON },
  });
  const valueByKey = new Map(missing.map((row) => [row.key, row.value]));
  const rows = written.flatMap((key) =>
    valueByKey.has(key) ? [{ key, value: valueByKey.get(key) ?? null }] : [],
  );
  if (rows.length > 0 || discarded.length > 0) {
    logger.info(
      {
        // The rows this removed, by key: an operator who sees a setting
        // disappear from the history has to find the line that removed it.
        discardedSettings: discarded.map((row) => row.key),
        // The key names, not a count: the operator's next question is always
        // "was THIS one stored", and a count cannot answer it. Names only, the
        // same rule the health field follows.
        importedSettings: rows.map((row) => row.key),
        importedSettingCount: rows.length,
        configuredVariables: migratedVariablesSetIn(environment).length,
      },
      "settings_environment_import",
    );
  }
  return rows;
}

/**
 * The import, once per process.
 *
 * The promise is memoised rather than the result, so two requests that start
 * before the first finishes share one write instead of racing into two. A
 * failure is memoised too, deliberately: a deployment whose database refuses
 * this write would otherwise retry it on every settings read for the life of
 * the process, and the resolution order still answers correctly from the
 * environment meanwhile. The failure is no longer the only trace of the
 * problem either, which is what makes swallowing it safe: the variables that
 * did not get stored keep showing up in `migratedVariablesUnstored`, on
 * `/health` and in the Settings banner, until somebody fixes it.
 *
 * The keys of the FIRST caller decide what is sent. A later caller cannot need
 * more written: anything missing then was missing now.
 *
 * What is memoised is that the import HAPPENED, not what it wrote. The rows are
 * handed to the caller whose read triggered the write, once, and then dropped:
 * that caller read the table before the write and would otherwise be the only
 * one missing them. Every later resolution reads the table alone, so a key an
 * operator resets in the same process goes back to answering from the
 * environment instead of being told forever that a deleted row still stores it.
 */
let importOnce: Promise<void> | null = null;
/** The rows the one import wrote, waiting for the caller that triggered it. */
let writtenRows: SettingsSeedRow[] = [];

export async function ensureEnvironmentSettingsImported(
  storedKeys: ReadonlySet<string>,
): Promise<SettingsSeedRow[]> {
  importOnce ??= storeEnvironmentValues(storedKeys)
    .then((rows) => {
      writtenRows = rows;
    })
    .catch((error: unknown) => {
      logger.warn({ err: error }, "settings_environment_import_failed");
    });
  await importOnce;
  const rows = writtenRows;
  writtenRows = [];
  return rows;
}

/** Forget that the import ran. Tests only: a process does this once. */
export function resetEnvironmentSettingsImportForTest(): void {
  importOnce = null;
  writtenRows = [];
}

/**
 * The migrated variables this deployment still sets, by name.
 *
 * The operator's to-do list: every one of these is a variable to remove, and
 * each one that survives into the cleanup release is a deployment that will
 * refuse to boot.
 */
export function migratedVariablesSet(): string[] {
  return migratedVariablesSetIn(settingsEnvironment);
}

/**
 * The subset of that list whose values are NOT stored yet, by name.
 *
 * Removing one of these would lose the value the deployment is running on, so
 * this is the list that has to be empty before the to-do list above is safe to
 * act on, and the one the cleanup stage waits for. Read from the resolution the
 * caller already has, so it states what the rows say now rather than what an
 * import once attempted.
 */
export function migratedVariablesUnstored(resolution: SettingsResolution): string[] {
  return migratedVariablesUnstoredIn(settingsEnvironment, resolution);
}
