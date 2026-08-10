/**
 * A unique-constraint violation (Postgres SQLSTATE 23505), read from wherever
 * it landed in the error's cause chain.
 *
 * The chain walk is required, not defensive: drizzle wraps a driver error in
 * its own query error and hangs the original off `cause`, so the SQLSTATE is
 * not on the error the caller catches. Depth is capped because a cause chain
 * is attacker-independent but still worth not trusting to be acyclic.
 *
 * No imports on purpose: this is shared into code paths that run inside a
 * Workflow step's isolate bundle, which has no node: builtins.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth += 1) {
    if (
      typeof current === "object" &&
      "code" in current &&
      (current as { code?: string }).code === "23505"
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
