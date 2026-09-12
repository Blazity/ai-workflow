import { NextResponse } from "next/server";

type WorkerProxy = (path: string, init?: RequestInit) => Promise<Response>;

/** A registry key: the worker rejects anything else, but the query parameter is
 *  re-encoded here so a hostile value cannot leave the one parameter it is in. */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

function isWorkerTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; name?: unknown };
  return candidate.name === "TimeoutError" || candidate.code === 23;
}

async function forward(
  workerProxy: WorkerProxy,
  path: string,
  init: RequestInit,
) {
  try {
    const response = await workerProxy(path, init);
    return NextResponse.json(await response.json().catch(() => ({})), {
      status: response.status,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (isWorkerTimeoutError(error)) {
      return NextResponse.json(
        { error: "Worker request timed out" },
        { status: 504, headers: { "cache-control": "no-store" } },
      );
    }
    throw error;
  }
}

/**
 * Reading the settings, or one key's history.
 *
 * `key` is the only parameter the worker route understands: with it the answer
 * is that key's recorded changes, without it the whole resolved set. Anything
 * else in the query is dropped rather than forwarded.
 */
export function handleSettingsGet(request: Request, workerProxy: WorkerProxy) {
  const key = new URL(request.url).searchParams.get("key");
  const path =
    key && SAFE_KEY.test(key)
      ? `/api/v1/settings?key=${encodeURIComponent(key)}`
      : "/api/v1/settings";
  return forward(workerProxy, path, { method: "GET" });
}

/** Changing settings. The worker owns the role rule and the registry
 *  validation, so the body travels untouched and its 400 or 403 comes back
 *  verbatim for the form to show. */
export async function handleSettingsPatch(
  request: Request,
  workerProxy: WorkerProxy,
) {
  return forward(workerProxy, "/api/v1/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: await request.text(),
  });
}
