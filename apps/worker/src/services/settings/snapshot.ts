/**
 * One resolved value per setting, read once and handed down synchronously.
 *
 * The store is asynchronous and the consumers are not: today's accessors
 * return values, not promises, and an accessor that silently started returning
 * a promise would read as truthy and flip a feature on. So an entry point (an
 * HTTP handler, a cron tick, the MCP transport, and later a run at its start)
 * loads one snapshot and passes it down; nothing below awaits a setting.
 *
 * Resolution order, until the cleanup stage removes the environment parsing:
 * the stored row, then the value the deployment's environment already
 * resolved to, then the registry default. A deployment with a configured
 * environment and an empty table therefore behaves exactly as it did before
 * this table existed.
 */
import {
  SETTINGS_REGISTRY,
  type SettingDefinition,
  type SettingValue,
  type SettingsSnapshot,
  type SettingsSource,
} from "@shared/contracts";
import { readAllConnectedSettings } from "../../db/repositories/settings.js";
import { env } from "../../infra/vcs-config.js";

/** The snapshot plus where each value came from, for the settings page. */
export interface SettingsResolution {
  snapshot: SettingsSnapshot;
  sources: ReadonlyMap<string, SettingsSource>;
}

/** One row the build-time seed would create from this deployment's variables. */
export interface SettingsSeedRow {
  key: string;
  value: SettingValue;
}

/**
 * The two checks variables are not in the parsed environment schema: the
 * checks runner reads them straight off `process.env` and says why in its own
 * comment. Reproducing that read here, rather than adding them to the schema,
 * keeps this stage from touching the environment module the cleanup stage
 * owns, and keeps "empty table plus environment equals today" true for them
 * too. Everything else comes from the parsed `env`, never from `process.env`.
 */
const CHECKS_TIMEOUT_VARIABLE = "PRE_PR_COMMAND_TIMEOUT_MINUTES";
const CHECKS_ALLOWED_ENV_VARIABLE = "PRE_PR_CHECKS_ALLOWED_ENV";

/**
 * Whether the deployment sets this variable at all.
 *
 * A presence question, not a value one: the parsed environment cannot answer
 * it, because a variable that is unset and one that is set to its schema
 * default both arrive as the same parsed value, and the seed and the "where
 * did this come from" label need to tell those apart. An empty string counts
 * as unset, which is what the environment module decides for every other key.
 */
function rawVariable(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? undefined : raw;
}

/** Today's read of the per-command checks timeout, minus its default. */
function checksTimeoutMinutes(): number | undefined {
  const raw = rawVariable(CHECKS_TIMEOUT_VARIABLE);
  const parsed = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : undefined;
}

/** Today's read of the forwarded-variable allowlist. */
function checksAllowedEnvNames(): readonly string[] | undefined {
  const raw = rawVariable(CHECKS_ALLOWED_ENV_VARIABLE);
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

/** What the environment resolves this key to, or undefined for "nothing". */
function environmentValue(definition: SettingDefinition): SettingValue | undefined {
  const name = definition.environmentVariable;
  if (name === null) return undefined;
  if (name === CHECKS_TIMEOUT_VARIABLE) return checksTimeoutMinutes();
  if (name === CHECKS_ALLOWED_ENV_VARIABLE) return checksAllowedEnvNames();

  // Passed through exactly as the environment schema resolved it, bounds
  // included. The registry's own bounds decide what an operator may write
  // through the API; applying them here as well would quietly change the value
  // a deployment already runs on, which is the one thing this stage must not
  // do. Only "nothing set" falls through to the default.
  const value = (env as unknown as Record<string, unknown>)[name];
  return value === undefined || value === null ? undefined : (value as SettingValue);
}

function resolveFrom(
  stored: ReadonlyMap<string, SettingValue>,
): SettingsResolution {
  const values: Record<string, SettingValue> = {};
  const sources = new Map<string, SettingsSource>();
  for (const definition of SETTINGS_REGISTRY) {
    const fromEnvironment = environmentValue(definition);
    if (stored.has(definition.key)) {
      values[definition.key] = stored.get(definition.key) ?? null;
      sources.set(definition.key, "stored");
      continue;
    }
    const isSet =
      definition.environmentVariable !== null &&
      rawVariable(definition.environmentVariable) !== undefined &&
      fromEnvironment !== undefined;
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

/**
 * The snapshot without touching the database.
 *
 * The transition fallback: every accessor that has not been handed a snapshot
 * yet resolves through this, so a caller converted in a later stage and one
 * that is not both see the same value on a deployment with an empty table.
 */
export function settingsSnapshotFromEnvironment(): SettingsSnapshot {
  return resolveFrom(new Map()).snapshot;
}

/** The snapshot and its sources, stored rows included. One database read. */
export async function loadSettingsResolution(): Promise<SettingsResolution> {
  const rows = await readAllConnectedSettings();
  return resolveFrom(new Map(rows.map((row) => [row.key, row.value])));
}

/** The snapshot one entry point loads and hands down. One database read. */
export async function loadSettingsSnapshot(): Promise<SettingsSnapshot> {
  return (await loadSettingsResolution()).snapshot;
}

/**
 * The rows the build-time seed writes: one per key whose variable this
 * deployment actually sets, carrying the value the environment already
 * resolved to. A key with no variable, and a variable left unset, produce no
 * row, so the resolution order keeps answering for them.
 */
export function settingsSeedRows(): SettingsSeedRow[] {
  const rows: SettingsSeedRow[] = [];
  for (const definition of SETTINGS_REGISTRY) {
    if (definition.environmentVariable === null) continue;
    if (rawVariable(definition.environmentVariable) === undefined) continue;
    const value = environmentValue(definition);
    if (value === undefined) continue;
    rows.push({ key: definition.key, value });
  }
  return rows;
}
