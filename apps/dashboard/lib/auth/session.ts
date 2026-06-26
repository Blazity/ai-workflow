import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const BASE = process.env.WORKER_BASE_URL ?? "";
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Server-side gate for the cockpit. Reads the ba_session cookie and validates
 * it against the worker. Missing, invalid, OR unverifiable (worker down) →
 * redirect to /login. One round-trip in the cockpit layout gates every page.
 *
 * Fails closed: we never render the cockpit on a session we couldn't confirm.
 * (Note: we do NOT clear the cookie here — cookie mutation is illegal during a
 * Server Component render. A stale cookie is overwritten at next login, or
 * cleared by the explicit logout route.)
 */
export async function requireSession(): Promise<void> {
  const token = (await cookies()).get("ba_session")?.value;
  if (!token) redirect("/login");

  let valid = false;
  try {
    const res = await fetch(`${BASE}/api/auth/get-session`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // Better Auth returns 200 with a null body when the token is invalid.
    valid = res.ok && (await res.json()) !== null;
  } catch {
    valid = false;
  }
  if (!valid) redirect("/login");
}
