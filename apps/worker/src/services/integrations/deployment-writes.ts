import type { IntegrationWriteAccess } from "@shared/contracts";

import { readConnectedDeploymentEnvironmentMarker } from "../../db/repositories/system-health.js";

/**
 * Whether this deployment may change an integration at all.
 *
 * Nothing else in this worker refuses a write on these grounds, so here is the
 * reason. Integration state is the only state a deployment writes that decides
 * what ANOTHER deployment does: disabling Slack here stops Slack there. The demo
 * deployment is a preview pointed at the production Neon branch
 * (`DATABASE_SHARED_WITH=production` in SETUP.md), so a toggle on demo would be
 * a production incident, and a developer whose `DATABASE_URL` happens to point
 * at production is the same incident with fewer witnesses.
 *
 * So the question is not "is this a preview" but "does this deployment own the
 * database it is about to write to". The database says what it is through the
 * `env_marker` row that `db:migrate` claims at build time.
 *
 * Reads are unaffected: seeing what is connected from a preview is useful and
 * harms nobody.
 */
export function decideIntegrationWriteAccess(input: {
  readonly deploymentEnv: string;
  readonly databaseEnv: string | null;
}): IntegrationWriteAccess {
  if (input.databaseEnv === null) {
    // Never a default of "allowed". An unclaimed database is either one this
    // build never migrated or one whose marker was removed, and both are states
    // where "which deployment owns this" has no answer.
    return {
      allowed: false,
      reason:
        "Integrations cannot be changed here: the database this deployment is connected to could not be confirmed. Either it carries no environment marker, or it could not be reached. Run the worker build's migration against it, check that it is up, then try again.",
    };
  }
  if (input.databaseEnv !== input.deploymentEnv) {
    return {
      allowed: false,
      reason:
        `Integrations cannot be changed here: this deployment is ${input.deploymentEnv}, ` +
        `and the database it is connected to is ${input.databaseEnv}. Changing an integration ` +
        `would change it for ${input.databaseEnv}. Use the ${input.databaseEnv} deployment.`,
    };
  }
  return { allowed: true };
}

/** What this deployment calls itself. Off Vercel there is no variable, and a
 *  local database claimed by `db:migrate` calls itself the same thing. */
export function deploymentEnvironment(): string {
  return process.env.VERCEL_ENV ?? "development";
}

/**
 * What the database says it is, or null when it could not be established.
 *
 * A read that throws is treated the same as a marker that is not there: a
 * database that cannot be reached cannot tell us who owns it either. The caller
 * turns both into the same refusal, so a database outage answers the write
 * controls with a sentence instead of a 500 that says nothing.
 */
export async function databaseEnvironment(): Promise<string | null> {
  try {
    return (await readConnectedDeploymentEnvironmentMarker())?.env ?? null;
  } catch {
    return null;
  }
}

export async function integrationWriteAccess(): Promise<IntegrationWriteAccess> {
  return decideIntegrationWriteAccess({
    deploymentEnv: deploymentEnvironment(),
    databaseEnv: await databaseEnvironment(),
  });
}
