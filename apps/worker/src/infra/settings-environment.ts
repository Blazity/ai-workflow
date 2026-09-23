/**
 * What this deployment's environment answers for a setting that names a
 * variable: a redeploy setting, whose only answer it is, and an integration's
 * setting, which reads it while nothing is stored.
 *
 * The other half of the resolution in `@shared/contracts/settings-resolution`:
 * that file owns the rule and this one owns the environment read, because
 * reading a variable is per-deployment wiring and the contracts package is
 * shared with the dashboard, which has no environment of this shape at all.
 *
 * Keyed by VARIABLE NAME rather than by a registry definition on purpose: the
 * infra tier has no outgoing edges under ADR-001, so it may not import the
 * registry to take one. A name is all the read needs, and turning a variable's
 * text into the shape its setting holds (a comma-separated list) is the
 * rule's, which has the definition.
 *
 * Both callers of the rule read the variables through this one module: an
 * HTTP request and a run at its start.
 */
import { env } from "./vcs-config.js";

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

/**
 * What the environment resolves this variable to, or undefined for "nothing".
 *
 * A variable the environment schema declares is passed through exactly as the
 * schema resolved it, bounds included. The registry's own bounds decide what
 * an operator may write through the API; applying them here as well would
 * quietly change the value a deployment already runs on. A variable the
 * schema does not declare (the checks allowlist, which the checks runner reads
 * off `process.env` itself, and every integration setting's variable) is
 * handed over as its raw text. Only "nothing set" falls through to the default.
 */
function settingsEnvironmentValue(
  variable: string,
): boolean | number | string | readonly string[] | null | undefined {
  const value = (env as unknown as Record<string, unknown>)[variable];
  return value === undefined || value === null
    ? rawVariable(variable)
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
