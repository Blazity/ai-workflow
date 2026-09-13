/**
 * What /health answers, decided below the transport.
 *
 * The identity fields come from deploymentIdentity next door; this binds the
 * connection it reads the env marker through, so the route stays a transport
 * adapter and the shape a verifier parses is decided in one place.
 */
import { deploymentIdentity, type DeploymentIdentity } from "./deployment-identity.js";

export interface HealthResponse extends DeploymentIdentity {
  status: "ok";
  timestamp: string;
}

/** The health payload, including the two identity facts a gate refuses on. */
export async function healthResponse(): Promise<HealthResponse> {
  return {
    status: "ok",
    timestamp: new Date().toISOString(),
    ...(await deploymentIdentity()),
  };
}
