import { eq } from "drizzle-orm";
import { env } from "../env.js";
import type { Db } from "./db/client.js";
import { envMarker } from "./db/schema.js";
import { logger } from "./lib/logger.js";

/**
 * What a deployment has to be able to say about itself before anything running
 * against it counts as evidence.
 *
 * `docs/delivery-gates.md` records G3 as BLOCKED for exactly two missing facts:
 * nothing proves the endpoint serves the candidate commit, and nothing proves
 * the deployment and the database belong together. This is those two facts and
 * nothing else, so `/health` can answer them without a caller having to trust
 * an alias, a deployment URL, or the order two pipelines happened to run in.
 */
export interface DeploymentIdentity {
  /** The commit this deployment was built from; null when the platform did not
   *  say, which a verifier must treat as unproven rather than as a match. */
  commit: string | null;
  /** The environment the running code believes it is. */
  env: string | null;
  /** The environment the database claims, read from the `env_marker` row that
   *  `scripts/db-migrate.ts` writes at build time. Null when it could not be
   *  read: an unreachable database must degrade this field, never fail the
   *  health check, because the gate refusing on null is the strict half. */
  databaseEnv: string | null;
}

// The marker is written once per build and never changes while a deployment
// lives, so one read per cold start is the whole cost.
let cachedDatabaseEnv: string | null | undefined;

/** Test-only: forget the cached marker so a case can observe the read again. */
export function resetDeploymentIdentityCache(): void {
  cachedDatabaseEnv = undefined;
}

async function readDatabaseEnv(openDb: () => Db): Promise<string | null> {
  if (cachedDatabaseEnv !== undefined) return cachedDatabaseEnv;
  try {
    const [row] = await openDb()
      .select({ env: envMarker.env })
      .from(envMarker)
      .where(eq(envMarker.id, 1))
      .limit(1);
    cachedDatabaseEnv = row?.env ?? null;
  } catch (error) {
    // Deliberately not cached: a transient failure must not pin this
    // deployment to "unknown database" for the rest of its life.
    logger.warn(
      { error: (error as Error).message },
      "deployment_identity_database_env_unreadable",
    );
    return null;
  }
  return cachedDatabaseEnv;
}

/**
 * Takes the handle lazily, and catches around opening it as well as around the
 * query. /health answered before this route knew anything about the database
 * and has to keep answering: a deployment too broken to open a connection is
 * exactly when somebody is asking health what is going on. The gate refusing a
 * null is what makes that safe.
 */
export async function deploymentIdentity(openDb: () => Db): Promise<DeploymentIdentity> {
  return {
    commit: env.VERCEL_GIT_COMMIT_SHA ?? null,
    env: env.VERCEL_ENV ?? null,
    databaseEnv: await readDatabaseEnv(openDb),
  };
}
