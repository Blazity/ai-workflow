import "server-only";
import { cookies } from "next/headers";
import { workerUrl } from "@/lib/auth/worker-core";
import { withoutWorkerLocation } from "@/lib/api/worker-errors";

const FETCH_TIMEOUT_MS = 10_000;

export async function proxyWorker(
  path: string,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const jar = await cookies();
  const session = jar.get("ba_session")?.value;
  const headers = new Headers(init.headers);
  if (session) headers.set("authorization", `Bearer ${session}`);

  const response = await fetch(workerUrl(process.env.WORKER_BASE_URL, path), {
    ...init,
    headers,
    cache: "no-store",
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
  });
  // Every route handler forwards what this returns to the browser, so the
  // worker's address is taken out of a refusal here, once, for all of them.
  return withoutWorkerLocation(response);
}
