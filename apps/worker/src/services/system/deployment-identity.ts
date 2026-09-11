import { deploymentSettings } from "../settings/index.js";
import { databaseFingerprint } from "../../db/database-fingerprint.js";
import { readConnectedDeploymentEnvironmentMarker } from "../../db/repositories/system-health.js";
import { logger } from "../../infra/logger.js";

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
  /** Which database branch, as a value that can be compared but not read back.
   *
   *  `apps/worker/e2e/scripts/check-db.ts` says outright that it proves the e2e
   *  DATABASE_URL reaches a migrated database and not that it is the same
   *  branch the deployment uses, because two migrated branches look identical
   *  from there. This is what makes them distinguishable: a caller holding a
   *  connection string derives the same fingerprint and compares. The host
   *  itself stays out of a public endpoint. */
  databaseFingerprint: string | null;
}

// The marker is written once per build and never changes while a deployment
// lives, so one read per cold start is the whole cost.
type Marker = { env: string | null; fingerprint: string | null };

const UNKNOWN_MARKER: Marker = { env: null, fingerprint: null };

let cachedMarker: Marker | undefined;

/** Test-only: forget the cached marker so a case can observe the read again. */
export function resetDeploymentIdentityCache(): void {
  cachedMarker = undefined;
}

async function readMarker(
  readEnvironmentMarker: () => Promise<{ env: string | null; endpointHost: string | null } | null>,
): Promise<Marker> {
  if (cachedMarker !== undefined) return cachedMarker;
  try {
    const row = await readEnvironmentMarker();
    cachedMarker = row
      ? { env: row.env, fingerprint: row.endpointHost ? databaseFingerprint(row.endpointHost) : null }
      : UNKNOWN_MARKER;
  } catch (error) {
    // Deliberately not cached: a transient failure must not pin this
    // deployment to "unknown database" for the rest of its life.
    logger.warn(
      { error: (error as Error).message },
      "deployment_identity_database_env_unreadable",
    );
    return UNKNOWN_MARKER;
  }
  return cachedMarker;
}

/**
 * Takes the handle lazily, and catches around opening it as well as around the
 * query. /health answered before this route knew anything about the database
 * and has to keep answering: a deployment too broken to open a connection is
 * exactly when somebody is asking health what is going on. The gate refusing a
 * null is what makes that safe.
 */
export async function deploymentIdentity(
  readEnvironmentMarker = readConnectedDeploymentEnvironmentMarker,
): Promise<DeploymentIdentity> {
  const marker = await readMarker(readEnvironmentMarker);
  const deployment = deploymentSettings();
  return {
    commit: deployment.commitSha ?? null,
    env: deployment.vercelEnv ?? null,
    databaseEnv: marker.env,
    databaseFingerprint: marker.fingerprint,
  };
}
