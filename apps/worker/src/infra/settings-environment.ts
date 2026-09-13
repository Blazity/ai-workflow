/**
 * What this deployment's environment still answers for a redeploy setting.
 *
 * The other half of the resolution in `@shared/contracts/settings-resolution`:
 * that file owns the rule and this one owns the remaining environment read,
 * because reading a variable is
 * per-deployment wiring and the contracts package is shared with the
 * dashboard, which has no environment of this shape at all.
 *
 * Keyed by VARIABLE NAME rather than by a registry definition on purpose: the
 * infra tier has no outgoing edges under ADR-001, so it may not import the
 * registry to take one. A name is all the read needs.
 *
 * Both callers of the rule read the three redeploy-owned variables through
 * this one module: an HTTP request and a run at its start.
 */
import { env } from "./vcs-config.js";

/**
 * The checks allowlist is read straight off `process.env` by the checks runner.
 * The other two redeploy-owned values come from the parsed environment.
 */
const CHECKS_ALLOWED_ENV_VARIABLE = "PRE_PR_CHECKS_ALLOWED_ENV";

/**
 * Whether the deployment sets this variable at all.
 *
 * A presence question, not a value one: the parsed environment cannot answer
 * it, because a variable that is unset and one that is set to its schema
 * default both arrive as the same parsed value, and the source label needs to
 * tell those apart. An empty string counts
 * as unset, which is what the environment module decides for every other key.
 */
function rawVariable(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? undefined : raw;
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
