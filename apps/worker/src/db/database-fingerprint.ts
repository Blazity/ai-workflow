import { createHash } from "node:crypto";

/**
 * A database branch as a value that can be compared but not read back.
 *
 * Two callers hold different things: the deployment holds the `env_marker` row
 * written at build time, and a CI job holds a connection string. Neither can
 * show the other its host (`/health` is public, and a connection string is a
 * secret), so they compare fingerprints instead.
 *
 * Normalised exactly as `apps/worker/scripts/db-migrate.ts` normalises before
 * claiming the marker: lower-cased, Neon's `-pooler` suffix stripped, so a
 * pooled and a direct url for one branch fingerprint the same. Truncated
 * because this is an equality token and not a secret store.
 *
 * Lives alone, importing only `node:crypto`, so the CI gate can use it without
 * dragging the worker's environment validation into a script.
 */
export function databaseFingerprint(endpointHost: string): string {
  const host = endpointHost.toLowerCase().replace(/-pooler(?=\.)/, "");
  return createHash("sha256").update(host).digest("hex").slice(0, 12);
}

/** The same fingerprint, taken from a connection string rather than a host. */
export function databaseFingerprintFromUrl(connectionString: string): string | null {
  try {
    return databaseFingerprint(new URL(connectionString).hostname);
  } catch {
    return null;
  }
}
