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
 *   variable is the thing being retired, so the row wins by definition.
 * - A key whose environment value equals the registry default is imported all
 *   the same. The point is not the number, it is that the number stops
 *   depending on a variable nobody will set again.
 * - A key marked `requiresRedeploy` is not imported at all: the deployment
 *   still reads that variable itself, so a stored row would be a second answer
 *   to the same question rather than a durable one.
 *
 * It runs at the first snapshot rather than at boot because the module graph is
 * loaded before a request exists, and a database read on import is what makes a
 * cold start fail in a place nobody can see.
 */
import {
  migratedVariablesSetIn,
  settingsSeedRowsFrom,
  type SettingsEnvironmentReader,
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

/** Writes the rows and returns the keys it created. Injected so a test can
 *  drive the decision without a database. */
type ImportWriter = (input: {
  rows: ReadonlyArray<{ key: string; value: unknown }>;
  actor: string;
  reason: string;
}) => Promise<string[]>;

/**
 * Store every migrated value this deployment resolves from its environment and
 * has no row for. Returns the keys actually written, which is empty on every
 * run after the first.
 */
export async function importEnvironmentSettings(
  environment: SettingsEnvironmentReader = settingsEnvironment,
  write: ImportWriter = importConnectedEnvironmentSettings as ImportWriter,
): Promise<string[]> {
  const rows = settingsSeedRowsFrom(environment);
  if (rows.length === 0) return [];
  const written = await write({
    rows,
    actor: IMPORT_ACTOR,
    reason: IMPORT_REASON,
  });
  if (written.length > 0) {
    logger.info(
      {
        // The key names, not a count: the operator's next question is always
        // "was THIS one stored", and a count cannot answer it. Names only, the
        // same rule the health field follows.
        importedSettings: written,
        importedSettingCount: written.length,
        configuredVariables: migratedVariablesSetIn(environment).length,
      },
      "settings_environment_import",
    );
  }
  return written;
}

/**
 * The import, once per process.
 *
 * The promise is memoised rather than the result, so two requests that start
 * before the first finishes share one write instead of racing into two. A
 * failure is memoised too, deliberately: a deployment whose database refuses
 * this write would otherwise retry it on every settings read for the life of
 * the process, and the resolution order still answers correctly from the
 * environment meanwhile, so the failure is worth a log line and nothing more.
 */
let importOnce: Promise<void> | null = null;

export function ensureEnvironmentSettingsImported(): Promise<void> {
  importOnce ??= importEnvironmentSettings().then(
    () => void 0,
    (error: unknown) => {
      logger.warn(
        { err: error },
        "settings_environment_import_failed",
      );
    },
  );
  return importOnce;
}

/** Forget that the import ran. Tests only: a process does this once. */
export function resetEnvironmentSettingsImportForTest(): void {
  importOnce = null;
}

/**
 * The migrated variables this deployment still sets, by name.
 *
 * What `/health` publishes and the Settings page turns into a banner. Every
 * value behind these names is stored by now, so each one is a variable the
 * operator can delete, and each one that survives into the cleanup release is
 * a deployment that will refuse to boot.
 */
export function migratedVariablesSet(): string[] {
  return migratedVariablesSetIn(settingsEnvironment);
}
