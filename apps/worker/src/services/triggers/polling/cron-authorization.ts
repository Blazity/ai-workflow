import { cronSecret } from "../../settings/index.js";

/**
 * Whether a cron invocation may run this pass.
 *
 * The platform sends the shared secret as a bearer token. A deployment without
 * one configured accepts every invocation, which is what a local or preview
 * worker relies on, so the absence of a secret is an explicit allow rather than
 * a silent deny.
 */
export function cronRequestIsAuthorized(authorizationHeader: string | undefined): boolean {
  const secret = cronSecret();
  if (!secret) return true;
  return authorizationHeader === `Bearer ${secret}`;
}
