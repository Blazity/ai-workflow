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
  type SettingValue,
  type SettingsSnapshot,
} from "./settings-registry";

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

/** Resolve every registry key: the stored row wins, then the environment,
 *  then the registry default. */
export function resolveSettingsSnapshot(
  stored: ReadonlyMap<string, SettingValue>,
  environment: SettingsEnvironmentReader,
): SettingsResolution {
  const values: Record<string, SettingValue> = {};
  const sources = new Map<string, SettingsSource>();
  for (const definition of SETTINGS_REGISTRY) {
    const variable = definition.environmentVariable;
    const fromEnvironment = variable === null ? undefined : environment.value(variable);
    if (stored.has(definition.key)) {
      values[definition.key] = stored.get(definition.key) ?? null;
      sources.set(definition.key, "stored");
      continue;
    }
    const isSet =
      variable !== null && environment.isSet(variable) && fromEnvironment !== undefined;
    values[definition.key] = fromEnvironment ?? definition.default;
    sources.set(definition.key, isSet ? "environment" : "default");
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
 * The rows the build-time seed writes: one per key whose variable this
 * deployment actually sets, carrying the value the environment already
 * resolved to. A key with no variable, and a variable left unset, produce no
 * row, so the resolution order keeps answering for them.
 */
export function settingsSeedRowsFrom(
  environment: SettingsEnvironmentReader,
): SettingsSeedRow[] {
  const rows: SettingsSeedRow[] = [];
  for (const definition of SETTINGS_REGISTRY) {
    const variable = definition.environmentVariable;
    if (variable === null) continue;
    if (!environment.isSet(variable)) continue;
    const value = environment.value(variable);
    if (value === undefined) continue;
    rows.push({ key: definition.key, value });
  }
  return rows;
}
