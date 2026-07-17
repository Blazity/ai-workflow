/**
 * Compose the Better Auth trusted-origin set: the canonical dashboard origin
 * first, then any additional origins, de-duplicated while preserving order.
 */
export function buildTrustedOrigins(primary: string, additional: readonly string[]): string[] {
  return [...new Set([primary, ...additional])];
}
