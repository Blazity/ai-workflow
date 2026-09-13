import { RETIRED_ENVIRONMENT_VARIABLES } from "@shared/contracts";

/**
 * Refuse deployment variables whose product behavior moved into the settings
 * store. The caller supplies the environment so the same side-effect-free
 * check can guard runtime boot, database migration, and credential-free builds.
 */
export function assertNoRetiredEnvironmentVariables(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const offenders = RETIRED_ENVIRONMENT_VARIABLES.filter(
    (name) => environment[name] !== undefined,
  );
  if (offenders.length === 0) return;

  throw new Error(
    "Invalid environment variables:\n" +
      `  Retired settings variables are still set: ${offenders.join(", ")}. ` +
      "Change these values on the Settings page or with MCP settings.set, then remove the variables. " +
      'See SETUP.md, section "Removing migrated environment variables".',
  );
}
