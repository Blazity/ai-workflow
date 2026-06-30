import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { fetchAuthWorker } from "@/lib/auth/worker";

export type DashboardSession = {
  role: "owner" | "admin" | "member";
  canManageUsers: boolean;
};

function isDashboardSession(value: unknown): value is DashboardSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<DashboardSession>;
  return (
    (session.role === "owner" ||
      session.role === "admin" ||
      session.role === "member") &&
    typeof session.canManageUsers === "boolean"
  );
}

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
export async function requireSession(): Promise<DashboardSession> {
  const token = (await cookies()).get("ba_session")?.value;
  if (!token) redirect("/login");

  const res = await fetchAuthWorker("/api/v1/session", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res?.ok) redirect("/login");

  const session = await res.json().catch(() => null);
  if (!isDashboardSession(session)) redirect("/login");
  return session;
}
