import "server-only";
import { cookies } from "next/headers";

const BASE = process.env.WORKER_BASE_URL;
const FETCH_TIMEOUT_MS = 10_000;

function workerUrl(path: string): string {
  if (!BASE) {
    throw new Error("WORKER_BASE_URL is required for dashboard API proxying");
  }

  return `${BASE}${path}`;
}

export async function proxyWorker(path: string, init: RequestInit = {}): Promise<Response> {
  const jar = await cookies();
  const session = jar.get("ba_session")?.value;
  const headers = new Headers(init.headers);
  if (session) headers.set("authorization", `Bearer ${session}`);

  return fetch(workerUrl(path), {
    ...init,
    headers,
    cache: "no-store",
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
      : AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}
