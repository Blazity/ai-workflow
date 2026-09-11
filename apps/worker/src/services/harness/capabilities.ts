/**
 * What a harness provider at a pinned CLI version can be asked to do.
 *
 * Request-time reads never launch provider discovery, so this only ever reads
 * the cached catalog; a missing catalog is the catalog's own 503 and not an
 * empty answer.
 */
import { getDb } from "../../db/client.js";
import {
  getCachedHarnessCapabilities,
  prewarmHarnessCapabilityCatalogs,
} from "../../harness-profiles/capability-catalog.js";
import type { HarnessProvider } from "@shared/contracts";

export function readCachedHarnessCapabilities(input: {
  organizationId: string;
  provider: HarnessProvider;
  cliVersion: string;
}) {
  return getCachedHarnessCapabilities(getDb(), input);
}

/**
 * Refill every cached catalog ahead of the requests that will read it. Only the
 * schedule calls this: a request-time miss stays a miss, because launching
 * provider discovery on the request path is what this cache exists to avoid.
 */
export function prewarmHarnessCapabilities() {
  return prewarmHarnessCapabilityCatalogs(getDb());
}
