/**
 * One resolved value per setting, from stored rows and registry defaults.
 *
 * The rule itself lives here, in the package every tier may import, because
 * two callers now need it and they are in tiers that cannot see each other:
 * an HTTP request resolves a snapshot through `services/settings`, and a run
 * resolves its own at run start from inside the engine, which ADR-001 forbids
 * from importing a service. A second implementation of "stored row, then
 * registry default, except for redeploy-owned environment values" is the one
 * outcome that would matter:
 * a run and the Settings page would disagree about the value the operator is
 * looking at, silently. Ordinary keys resolve from a stored row and then their
 * default; the three `requiresRedeploy` keys remain environment owned because
 * their consumers cannot read the store yet. An ordinary key that names a
 * variable (only an integration's setting does) reads it between the two: a
 * stored row, then the variable, then the default.
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
 * What ONE key resolves to with no stored row: the variable it names, when it
 * names one and the deployment sets it, and otherwise its default.
 *
 * The second and third steps of the rule, on their own, for the caller that has
 * exactly one key in hand and no reason to read every row in the table: the
 * reset operation, which has to record what takes over once the row it removes
 * is gone. The loop below applies the same rule per definition.
 *
 * Null for a key `find` does not know, which is a question for the caller's
 * own validation and not something to answer with a default. `find` is this
 * build's one lookup (`settingDefinition` in `@integrations/registry`), for the
 * reason `validateSettingsPatch` gives.
 */
export function resolveSettingWithoutStoredRow(
  key: string,
  environment: SettingsEnvironmentReader,
  find: (key: string) => SettingDefinition | undefined,
): { value: SettingValue; source: "environment" | "default" } | null {
  const definition = find(key);
  return definition ? withoutStoredRow(definition, environment) : null;
}

function withoutStoredRow(
  definition: SettingDefinition,
  environment: SettingsEnvironmentReader,
): { value: SettingValue; source: "environment" | "default" } {
  const variable = definition.environmentVariable;
  const fromEnvironment =
    variable === undefined ? undefined : environmentValue(definition, environment.value(variable));
  const isSet =
    variable !== undefined && environment.isSet(variable) && fromEnvironment !== undefined;
  return {
    value: fromEnvironment ?? definition.default,
    source: isSet ? "environment" : "default",
  };
}

/**
 * A variable's value in the shape its setting holds.
 *
 * The reader hands back what the deployment's parsed environment says, or the
 * raw text of a variable that schema does not declare. A list setting read
 * from raw text is split the way this product has always split one
 * (`SLACK_ALLOWED_USER_IDS` and `PRE_PR_CHECKS_ALLOWED_ENV` on main): on
 * commas, each entry trimmed, empties dropped. So `"U1, U2,,"` is two entries
 * and `" , , "` is none, which for an allowlist means nobody is singled out.
 */
function environmentValue(
  definition: SettingDefinition,
  value: SettingValue | undefined,
): SettingValue | undefined {
  if (definition.type !== "string-list" || typeof value !== "string") return value;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * Resolve every registry key: an ordinary stored row wins, then the variable
 * the key names (if any), then the registry default. A `requiresRedeploy` key
 * ignores a leftover row and resolves from its environment variable, then its
 * default.
 *
 * With one exception, and it is the whole reason `requiresRedeploy` exists. For
 * a key so marked the running code reads the variable itself, at module load or
 * inside a step, and a stored row cannot reach that reader. Letting the row win
 * here would give one key two live answers: this snapshot would report the row
 * while the code kept using the variable, and the Settings page would show a
 * value nothing was acting on. So the environment is the single truth for those
 * keys, a row for one is ignored rather than obeyed, and the surfaces that could
 * create such a row refuse to.
 *
 * `contributed` are the settings integrations declare (`integrationSettingDefinitions`
 * in `@integrations/registry`), resolved by the same rule. The snapshot carries
 * their values under their keys at run time; `SettingsSnapshot` types core's
 * keys only, because an integration's value reaches its own code through
 * `ctx.settings`, never through a typed read of this object. A run resolves
 * its own snapshot without them: nothing inside a run reads one today.
 */
export function resolveSettingsSnapshot(
  stored: ReadonlyMap<string, SettingValue>,
  environment: SettingsEnvironmentReader,
  contributed: readonly SettingDefinition[] = [],
): SettingsResolution {
  const values: Record<string, SettingValue> = {};
  const sources = new Map<string, SettingsSource>();
  for (const definition of [...REGISTRY, ...contributed]) {
    if (stored.has(definition.key) && !definition.requiresRedeploy) {
      values[definition.key] = stored.get(definition.key) ?? null;
      sources.set(definition.key, "stored");
      continue;
    }
    const resolved = withoutStoredRow(definition, environment);
    values[definition.key] = resolved.value;
    sources.set(definition.key, resolved.source);
  }
  // The registry derives SettingsSnapshot key by key, so this object holds
  // exactly its keys, plus any contributed ones; the cast is the one place
  // that fact is asserted.
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
