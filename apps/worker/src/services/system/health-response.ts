/**
 * What /health answers, decided below the transport.
 *
 * The identity fields come from deploymentIdentity next door; this binds the
 * connection it reads the env marker through, so the route stays a transport
 * adapter and the shape a verifier parses is decided in one place.
 */
import { logger } from "../../infra/logger.js";
import {
  migratedVariablesSet,
  migratedVariablesStatusReadOnly,
} from "../settings/index.js";
import { deploymentIdentity, type DeploymentIdentity } from "./deployment-identity.js";

/** What this deployment still owes the settings migration. */
interface HealthSettings {
  /**
   * The migrated environment variables this deployment still sets, by name.
   *
   * Names, never values: this endpoint is public enough that a verifier can
   * curl it, and the question an operator has here is only which variables are
   * left to delete. Empty means the deployment no longer sets any of them,
   * which is what the cleanup release, which refuses to boot with one set,
   * needs to be true.
   */
  migratedVariablesSet: string[];
  /**
   * Those of them this deployment has no stored row for, by name.
   *
   * The list that decides whether removing a variable is safe. A name here
   * means the value lives nowhere but the variable, so deleting it would
   * change what the deployment does. It is read from the settings table on
   * every call rather than remembered from the import, so a write that failed,
   * a database restored behind the process, or a row somebody removed all show
   * up here instead of being reported as done.
   *
   * `null` means the table could not be read at all. It is deliberately not an
   * empty list: empty says "every one of them is stored, remove away", and a
   * deployment whose database is refusing has no idea whether that is true.
   */
  migratedVariablesUnstored: string[] | null;
}

export interface HealthResponse extends DeploymentIdentity {
  status: "ok";
  timestamp: string;
  settings: HealthSettings;
}

/**
 * The settings half, which must not be able to take /health down.
 *
 * Same argument as the identity fields next door: this endpoint answered
 * before it knew anything about the database and has to keep answering, since
 * a deployment too broken to read a table is exactly when somebody curls it.
 * The names of the variables this deployment sets come from the environment
 * and cannot fail; only the "is it stored" half needs the table, and that half
 * degrades to `null` rather than to a comforting empty list.
 *
 * The read-only variant, too: /health takes no authentication, and a public
 * endpoint must not be able to make this process write rows.
 */
async function healthSettings(): Promise<HealthSettings> {
  try {
    const status = await migratedVariablesStatusReadOnly();
    return {
      migratedVariablesSet: status.set,
      migratedVariablesUnstored: status.unstored,
    };
  } catch (error) {
    logger.warn(
      { error: (error as Error).message },
      "health_settings_table_unreadable",
    );
    return { migratedVariablesSet: migratedVariablesSet(), migratedVariablesUnstored: null };
  }
}

/** The health payload, including the two identity facts a gate refuses on. */
export async function healthResponse(): Promise<HealthResponse> {
  return {
    status: "ok",
    timestamp: new Date().toISOString(),
    ...(await deploymentIdentity()),
    settings: await healthSettings(),
  };
}
