/**
 * The shape of `INTEGRATION_SECRETS_KEY`, in one place.
 *
 * Its own module with no imports at all, because the two callers cannot import
 * each other: `runtime-env.ts` validates the variable at boot and must stay free
 * of Node modules (it is reachable from code the Workflow DevKit bundles, where
 * a `node:` import fails the Vercel build and nothing local), while
 * `secrets-crypto.ts` needs `node:crypto`. A literal copied into both is how the
 * two rules drift.
 */

/** AES-256 needs 32 bytes; the variable carries them as lowercase or uppercase hex. */
export function isValidIntegrationSecretsKey(key: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(key);
}
