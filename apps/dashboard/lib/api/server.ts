// apps/dashboard/lib/api/server.ts
import "server-only";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/errors";
import { workerUrl } from "@/lib/auth/worker-core";

const FETCH_TIMEOUT_MS = 10_000;

/** Append a query string, skipping empty/undefined values. */
export function withQuery(
  path: string,
  params: Record<string, string | null | undefined>,
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const qs = sp.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * Server-only JSON fetch. Runs on the Next server (never the browser), so no
 * CORS and no NEXT_PUBLIC_ exposure. `no-store` => fresh on every full page load.
 *
 * Reads the `ba_session` cookie set by Better Auth on the worker and forwards it
 * as `Authorization: Bearer <token>` so the worker's `/api/v1/*` gate accepts the
 * request. Since this runs server-side, the cookie value never reaches the browser.
 * If the session cookie is absent the request is sent without a credential — the
 * worker returns 401 and getJSON throws UnauthorizedError so callers can redirect
 * to /login.
 */
export async function getJSON<T>(path: string): Promise<T> {
  const jar = await cookies();
  const session = jar.get("ba_session")?.value;
  const res = await fetch(workerUrl(process.env.WORKER_BASE_URL, path), {
    cache: "no-store",
    headers: session ? { Authorization: `Bearer ${session}` } : undefined,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 401) {
    throw new UnauthorizedError(path);
  }
  if (res.status === 403) {
    throw new ForbiddenError(path);
  }
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Use in a server component's `.catch` so non-auth failures degrade to the
 * existing mock fallback, but a 401 redirects to /login instead of silently
 * showing mock data. `redirect()` throws NEXT_REDIRECT, which Next handles
 * server-side (do not wrap this in another try/catch).
 */
export function authAwareFallback<T>(err: unknown, fallback: () => T): T {
  if (err instanceof UnauthorizedError) {
    redirect("/login");
  }
  if (err instanceof ForbiddenError) {
    throw err;
  }
  return fallback();
}
