/**
 * One resolved value per setting, from stored rows plus whatever the
 * deployment's environment still answers for.
 *
 * The rule itself lives here, in the package every tier may import, because
 * two callers now need it and they are in tiers that cannot see each other:
 * an HTTP request resolves a snapshot through `services/settings`, and a run
 * resolves its own at run start from inside the engine, which ADR-001 forbids
 * from importing a service. A second implementation of "stored row, then
 * environment, then registry default" is the one outcome that would matter:
 * a run and the Settings page would disagree about the value the operator is
 * looking at, silently.
 *
 * Reading the environment is NOT here. That half is per-deployment wiring
 * (`process.env` plus the worker's parsed schema), and this package is shared
 * with the dashboard, so the caller hands it in as a reader keyed by variable
 * name.
 */
import type { SettingsSource } from "./settings-api";
import {
  SETTINGS_REGISTRY,
  type SettingDefinition,
  type SettingValue,
  type SettingsSnapshot,
} from "./settings-registry";

/**
 * The registry through its declared interface.
 *
 * `SETTINGS_REGISTRY` is `as const`, so an entry that omits an optional field
 * does not have it in its literal type at all, and `definition.requiresRedeploy`
 * would not compile on the entries that leave it out. Widening once here says
 * "read this as the interface" rather than repeating a cast at each use.
 */
const REGISTRY: readonly SettingDefinition[] = SETTINGS_REGISTRY;

/** The deployment's environment, as this resolution may consult it. */
export interface SettingsEnvironmentReader {
  /**
   * What the environment resolves this variable to, or undefined for
   * "nothing". Bounds included: the value a deployment already runs on must
   * not change because it passed through here.
   */
  value(variable: string): SettingValue | undefined;
  /**
   * Whether the deployment sets the variable at all. A presence question, not
   * a value one: a variable that is unset and one set to its schema default
   * resolve to the same value, and only this tells the "where did it come
   * from" label and the seed apart.
   */
  isSet(variable: string): boolean;
}

/** The snapshot plus where each value came from, for the settings page. */
export interface SettingsResolution {
  snapshot: SettingsSnapshot;
  sources: ReadonlyMap<string, SettingsSource>;
}

/**
 * The registry by key, built once.
 *
 * The snapshot below resolves every key on every request and now asks per key,
 * so a scan of the array inside that loop would make a linear read quadratic.
 * Module level rather than rebuilt per call: the registry is a frozen literal
 * and cannot change while the process is up.
 */
const DEFINITIONS_BY_KEY: ReadonlyMap<string, (typeof SETTINGS_REGISTRY)[number]> =
  new Map(SETTINGS_REGISTRY.map((definition) => [definition.key, definition]));

/**
 * What ONE key resolves to with no stored row: the environment, then the
 * registry default.
 *
 * The second and third steps of the rule, on their own, for the caller that has
 * exactly one key in hand and no reason to read every row in the table: the
 * reset operation, which has to record what takes over once the row it removes
 * is gone. Exported and used by the loop below rather than restated there, so
 * there is still one implementation of "environment, then default".
 *
 * Null for a key the registry does not know, which is a question for the
 * caller's own validation and not something to answer with a default.
 */
export function resolveSettingWithoutStoredRow(
  key: string,
  environment: SettingsEnvironmentReader,
): { value: SettingValue; source: "environment" | "default" } | null {
  const definition = DEFINITIONS_BY_KEY.get(key);
  if (!definition) return null;
  const variable = definition.environmentVariable;
  const fromEnvironment = variable === null ? undefined : environment.value(variable);
  const isSet =
    variable !== null && environment.isSet(variable) && fromEnvironment !== undefined;
  return {
    value: fromEnvironment ?? definition.default,
    source: isSet ? "environment" : "default",
  };
}

/**
 * Resolve every registry key: the stored row wins, then the environment, then
 * the registry default.
 *
 * With one exception, and it is the whole reason `requiresRedeploy` exists. For
 * a key so marked the running code reads the variable itself, at module load or
 * inside a step, and a stored row cannot reach that reader. Letting the row win
 * here would give one key two live answers: this snapshot would report the row
 * while the code kept using the variable, and the Settings page would show a
 * value nothing was acting on. So the environment is the single truth for those
 * keys, a row for one is ignored rather than obeyed, and the surfaces that could
 * create such a row refuse to.
 */
export function resolveSettingsSnapshot(
  stored: ReadonlyMap<string, SettingValue>,
  environment: SettingsEnvironmentReader,
): SettingsResolution {
  const values: Record<string, SettingValue> = {};
  const sources = new Map<string, SettingsSource>();
  for (const definition of REGISTRY) {
    if (stored.has(definition.key) && !definition.requiresRedeploy) {
      values[definition.key] = stored.get(definition.key) ?? null;
      sources.set(definition.key, "stored");
      continue;
    }
    // Never null here: the key came from the registry this resolves.
    const resolved = resolveSettingWithoutStoredRow(definition.key, environment);
    values[definition.key] = resolved?.value ?? definition.default;
    sources.set(definition.key, resolved?.source ?? "default");
  }
  // The registry derives SettingsSnapshot key by key, so this object holds
  // exactly its keys; the cast is the one place that fact is asserted.
  return {
    snapshot: Object.freeze(values) as unknown as SettingsSnapshot,
    sources,
  };
}

/** No stored rows and no environment, so every key answers with its registry
 *  default. */
const NO_ENVIRONMENT: SettingsEnvironmentReader = {
  value: () => void 0,
  isSet: () => false,
};

/**
 * The registry defaults alone.
 *
 * For the two callers that must fill a gap without consulting anything: a run
 * replaying a snapshot written before a key existed, and a step replaying an
 * input written before a field existed. Both want exactly "what a deployment
 * with nothing configured would have used", and both must NOT read the
 * environment, because a value that changed under a suspended run is the drift
 * the frozen snapshot exists to prevent.
 */
export function defaultSettingsSnapshot(): SettingsSnapshot {
  return resolveSettingsSnapshot(new Map(), NO_ENVIRONMENT).snapshot;
}

/** One row the build-time seed would create from this deployment's variables. */
export interface SettingsSeedRow {
  key: string;
  value: SettingValue;
}

/**
 * Every variable the cleanup stage will stop parsing.
 *
 * A key marked `requiresRedeploy` is deliberately absent: this deployment
 * still reads that variable itself, so removing it would break the deployment
 * rather than tidy it. The two lists this feeds (what to import, what to tell
 * the operator to remove) must be the same list or an operator would delete a
 * variable nothing stored.
 */
export function migratedSettingVariables(): string[] {
  return REGISTRY.filter(
    (definition) => definition.environmentVariable !== null && !definition.requiresRedeploy,
  ).map((definition) => definition.environmentVariable as string);
}

/**
 * The migrated variables this deployment still sets, by name.
 *
 * Names only, never values: the list is published on `/health` and on the
 * Settings page, and half of these variables carry nothing secret while the
 * other half is nobody's business. Presence is the whole question an operator
 * has here.
 */
export function migratedVariablesSetIn(
  environment: SettingsEnvironmentReader,
): string[] {
  return migratedSettingVariables().filter((variable) => environment.isSet(variable));
}

/**
 * The migrated variables this deployment sets that have no stored row yet.
 *
 * The honest half of the pair above. `migratedVariablesSetIn` answers "what is
 * still set", which is the operator's to-do list; this answers "what would be
 * LOST if you acted on it now", which is the only question that makes the
 * to-do list safe to act on. A name leaves this list the moment a row exists
 * for its key, whoever wrote it: the import, the build-time seed or an
 * operator on the Settings page.
 *
 * Taken from a resolution rather than from a set of keys so it cannot drift
 * from what the same read resolved: the test is `source === "environment"`,
 * which is exactly "the variable is what this deployment is running on".
 * A stored row answering instead makes the variable safe to remove, and so
 * does a variable that is set but parses to nothing (`FOO=` or `FOO=0` where
 * zero is not a value the key accepts): the deployment already resolves that
 * key to its registry default, so removing the variable loses nothing. Such a
 * variable stays on the to-do list above, because the cleanup release still
 * refuses to boot with it set.
 */
export function migratedVariablesUnstoredIn(
  environment: SettingsEnvironmentReader,
  resolution: SettingsResolution,
): string[] {
  return REGISTRY.filter(
    (definition) =>
      definition.environmentVariable !== null &&
      !definition.requiresRedeploy &&
      environment.isSet(definition.environmentVariable) &&
      resolution.sources.get(definition.key) === "environment",
  ).map((definition) => definition.environmentVariable as string);
}

/**
 * Every `requiresRedeploy` key, with the value that answers for it once no
 * stored row is in the way.
 *
 * A row for one of these is ignored by the resolution above, which makes it a
 * lie in the only place an operator can see it: the Settings history says
 * somebody set the key, and the running code has never read it. The import
 * deletes such rows, and records each removal with this value as the new one,
 * so the history reads as "the environment took this key back" rather than as
 * a row vanishing.
 */
export function redeployOwnedSettingRows(
  environment: SettingsEnvironmentReader,
): SettingsSeedRow[] {
  const { snapshot } = resolveSettingsSnapshot(new Map(), environment);
  const values = snapshot as unknown as Record<string, SettingValue>;
  return REGISTRY.filter((definition) => definition.requiresRedeploy).map(
    (definition) => ({ key: definition.key, value: values[definition.key] ?? null }),
  );
}

/**
 * The rows the build-time seed and the runtime import write: one per key whose
 * variable this deployment actually sets, carrying the value the environment
 * already resolved to. A key with no variable, and a variable left unset,
 * produce no row, so the resolution order keeps answering for them.
 *
 * A `requiresRedeploy` key produces no row either. Its variable is not going
 * away, and a stored row would win over the environment in the resolution
 * above while the module-load reader kept answering from the variable: one key
 * with two live answers is exactly the drift this migration exists to end.
 */
export function settingsSeedRowsFrom(
  environment: SettingsEnvironmentReader,
): SettingsSeedRow[] {
  const rows: SettingsSeedRow[] = [];
  for (const definition of REGISTRY) {
    const variable = definition.environmentVariable;
    if (variable === null) continue;
    if (definition.requiresRedeploy) continue;
    if (!environment.isSet(variable)) continue;
    const value = environment.value(variable);
    if (value === undefined) continue;
    rows.push({ key: definition.key, value });
  }
  return rows;
}
