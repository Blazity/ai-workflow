import { timingSafeEqual } from "node:crypto";
import { createError } from "h3";

/**
 * Verify a request's `Authorization: Bearer <token>` against the expected
 * shared secret using a constant-time comparison. Throws a 401 on any failure.
 *
 * Used to gate the read-only `/api/v1/*` observability API: the dashboard runs
 * a server-side fetch with this token, so only a caller that holds the secret
 * can reach the worker (the token never reaches the browser). See
 * `src/middleware/api-auth.ts`.
 */
export function verifyApiToken(
  authHeader: string | undefined,
  expectedToken: string,
): void {
  const provided = parseBearer(authHeader);
  if (!provided) {
    throw createError({ statusCode: 401, statusMessage: "Missing bearer token" });
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw createError({ statusCode: 401, statusMessage: "Invalid API token" });
  }
}

/** Extract the token from an `Authorization: Bearer <token>` header. */
function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(" ", 2);
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}
