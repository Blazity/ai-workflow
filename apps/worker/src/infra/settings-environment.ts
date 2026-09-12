/**
 * What this deployment's environment still answers for a setting.
 *
 * The other half of the resolution in `@shared/contracts/settings-resolution`:
 * that file owns the rule (stored row, then environment, then registry
 * default) and this one owns the read, because reading a variable is
 * per-deployment wiring and the contracts package is shared with the
 * dashboard, which has no environment of this shape at all.
 *
 * Keyed by VARIABLE NAME rather than by a registry definition on purpose: the
 * infra tier has no outgoing edges under ADR-001, so it may not import the
 * registry to take one. A name is all the read needs.
 *
 * Both callers of the rule read the environment through this one module: an
 * HTTP request (through `services/settings`) and a run at its start (through
 * the engine's run-start step, which may not import a service). The cleanup
 * stage removes the parsing and this module with it.
 */
import { env } from "./vcs-config.js";

/**
 * The two checks variables are not in the parsed environment schema: the
 * checks runner reads them straight off `process.env` and says why in its own
 * comment. Reproducing that read here, rather than adding them to the schema,
 * keeps "empty table plus environment equals today" true for them too.
 * Everything else comes from the parsed `env`, never from `process.env`.
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

/** What the environment resolves this variable to, or undefined for "nothing". */
function settingsEnvironmentValue(
  variable: string,
): boolean | number | string | readonly string[] | null | undefined {
  if (variable === CHECKS_TIMEOUT_VARIABLE) return checksTimeoutMinutes();
  if (variable === CHECKS_ALLOWED_ENV_VARIABLE) return checksAllowedEnvNames();

  // Passed through exactly as the environment schema resolved it, bounds
  // included. The registry's own bounds decide what an operator may write
  // through the API; applying them here as well would quietly change the value
  // a deployment already runs on. Only "nothing set" falls through to the
  // default.
  const value = (env as unknown as Record<string, unknown>)[variable];
  return value === undefined || value === null
    ? undefined
    : (value as boolean | number | string | readonly string[]);
}

/** Whether the deployment sets this variable at all. */
function settingsEnvironmentIsSet(variable: string): boolean {
  return rawVariable(variable) !== undefined;
}

/** This deployment's environment, as the shared resolution consults it. The two
 *  functions are not exported separately: the resolution takes the pair, and a
 *  second entry point nobody asked for is what the unused-code gate is for. */
export const settingsEnvironment = {
  value: settingsEnvironmentValue,
  isSet: settingsEnvironmentIsSet,
};
