import "server-only";
import { cookies } from "next/headers";
import { workerUrl } from "@/lib/auth/worker-core";

const FETCH_TIMEOUT_MS = 10_000;

export async function proxyWorker(path: string, init: RequestInit = {}): Promise<Response> {
  const jar = await cookies();
  const session = jar.get("ba_session")?.value;
  const headers = new Headers(init.headers);
  if (session) headers.set("authorization", `Bearer ${session}`);

  return fetch(workerUrl(process.env.WORKER_BASE_URL, path), {
    ...init,
    headers,
    cache: "no-store",
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
      : AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}
