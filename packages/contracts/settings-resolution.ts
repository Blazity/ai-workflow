/**
 * One resolved value per setting, from stored rows and registry defaults.
 *
 * The rule itself lives here, in the package every tier may import, because
 * two callers now need it and they are in tiers that cannot see each other:
 * an HTTP request resolves a snapshot through `services/settings`, and a run
 * resolves its own at run start from inside the engine, which ADR-001 forbids
 * from importing a service. A second implementation of "stored row, then
 * environment, then registry default" is the one outcome that would matter:
 * a run and the Settings page would disagree about the value the operator is
 * looking at, silently. Ordinary keys resolve from a stored row and then their
 * default; the three `requiresRedeploy` keys remain environment owned because
 * their consumers cannot read the store yet.
 *
 * Accessing `process.env` is NOT here. That half is per-deployment wiring
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
   * resolve to the same value, and only this tells the source label apart.
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
const DEFINITIONS_BY_KEY: ReadonlyMap<string, SettingDefinition> =
  new Map(SETTINGS_REGISTRY.map((definition) => [definition.key, definition]));

/**
 * What ONE key resolves to with no stored row: the registry default, except
 * for a `requiresRedeploy` key, which reads the environment first.
 *
 * The second and third steps of the rule, on their own, for the caller that has
 * exactly one key in hand and no reason to read every row in the table: the
 * reset operation, which has to record what takes over once the row it removes
 * is gone. Exported and used by the loop below rather than restated there.
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
  const fromEnvironment = definition.requiresRedeploy && variable
    ? environment.value(variable)
    : undefined;
  const isSet =
    definition.requiresRedeploy === true &&
    variable !== undefined &&
    environment.isSet(variable) &&
    fromEnvironment !== undefined;
  return {
    value: fromEnvironment ?? definition.default,
    source: isSet ? "environment" : "default",
  };
}

/**
 * Resolve every registry key: an ordinary stored row wins, then the registry
 * default. A `requiresRedeploy` key ignores a leftover row and resolves from
 * its environment variable, then its default.
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
