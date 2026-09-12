/**
 * What /health answers, decided below the transport.
 *
 * The identity fields come from deploymentIdentity next door; this binds the
 * connection it reads the env marker through, so the route stays a transport
 * adapter and the shape a verifier parses is decided in one place.
 */
import { migratedVariablesSet } from "../settings/index.js";
import { deploymentIdentity, type DeploymentIdentity } from "./deployment-identity.js";

/** What this deployment still owes the settings migration. */
interface HealthSettings {
  /**
   * The migrated environment variables this deployment still sets, by name.
   *
   * Names, never values: this endpoint is public enough that a verifier can
   * curl it, and the question an operator has here is only which variables are
   * left to delete. Empty means the deployment is ready for the cleanup
   * release, which refuses to boot with any of them set.
   */
  migratedVariablesSet: string[];
}

export interface HealthResponse extends DeploymentIdentity {
  status: "ok";
  timestamp: string;
  settings: HealthSettings;
}

/** The health payload, including the two identity facts a gate refuses on. */
export async function healthResponse(): Promise<HealthResponse> {
  return {
    status: "ok",
    timestamp: new Date().toISOString(),
    ...(await deploymentIdentity()),
    settings: { migratedVariablesSet: migratedVariablesSet() },
  };
}
