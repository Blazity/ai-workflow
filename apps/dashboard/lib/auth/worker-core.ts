const WORKER_TIMEOUT_MS = 10_000;

function workerUrl(base: string | undefined, path: string): string {
  if (!base) {
    throw new Error("WORKER_BASE_URL is required for dashboard auth requests");
  }

  return `${base}${path}`;
}

export async function fetchWorker(
  base: string | undefined,
  path: string,
  init: RequestInit = {},
): Promise<Response | null> {
  try {
    return await fetch(workerUrl(base, path), {
      ...init,
      cache: "no-store",
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(WORKER_TIMEOUT_MS)])
        : AbortSignal.timeout(WORKER_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}
