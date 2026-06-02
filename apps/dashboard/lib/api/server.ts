// apps/dashboard/lib/api/server.ts
const BASE = process.env.WORKER_BASE_URL ?? "";
const TOKEN = process.env.WORKER_API_TOKEN ?? "";

/**
 * Server-only JSON fetch. Runs on the Next server (never the browser), so no
 * CORS and no NEXT_PUBLIC_ exposure. `no-store` => fresh on every full page load.
 *
 * Sends the shared `WORKER_API_TOKEN` as a bearer credential so the worker's
 * `/api/v1/*` gate accepts the request. Since this runs server-side, the token
 * never reaches the browser. If the token is unset the request is sent without
 * it — the worker then returns 401 and the caller's try/catch falls back to the
 * documented empty/N-A state instead of crashing.
 */
export async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    cache: "no-store",
    headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : undefined,
  });
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}
