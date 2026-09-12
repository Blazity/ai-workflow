// apps/dashboard/app/api/repository-catalog/handler.ts
//
// The browser half of the repository catalog. One handler per worker route,
// shaped exactly like app/api/settings/handler.ts: the session travels through
// proxyWorker, the worker's status and body come back verbatim, and a worker
// that never answers becomes a 504 rather than an unhandled rejection.
//
// Nothing here decides a role. The worker refuses a member's write with a 403
// and that 403 is what the screen renders, so a second copy of the rule cannot
// drift away from the one that is enforced.
import { NextResponse } from "next/server";

/** proxyWorker's own shape, third parameter included: the suggestion route is
 *  the one call that needs a longer ceiling than the default. */
type WorkerProxy = (
  path: string,
  init?: RequestInit,
  timeoutMs?: number,
) => Promise<Response>;

/**
 * How long the suggestion proxy waits.
 *
 * The worker's documented worst case is 150 seconds: 60 for the profile read
 * plus 90 for the model call, and it answers a 503 of its own when either runs
 * out. A dashboard timeout shorter than that would turn the worker's own
 * explained refusal into an unexplained 504, so this sits above the worst case
 * and below the route's `maxDuration`, which is above it again
 * (app/api/repository-catalog/suggest/route.ts).
 */
export const SUGGEST_TIMEOUT_MS = 160_000;

function isWorkerTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; name?: unknown };
  return candidate.name === "TimeoutError" || candidate.code === 23;
}

async function forward(
  workerProxy: WorkerProxy,
  path: string,
  init: RequestInit,
  timeoutMs?: number,
) {
  try {
    const response = await workerProxy(path, init, timeoutMs);
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
 * A repository id as it may appear in a path segment.
 *
 * Digits only, and re-encoded on the way out. The worker refuses anything else,
 * but a hostile segment must not be able to leave the segment it is in and add
 * a path of its own to the worker URL.
 */
function repositoryPath(id: string, suffix = ""): string | null {
  if (!/^[0-9]{1,12}$/.test(id)) return null;
  return `/api/v1/repository-catalog/${encodeURIComponent(id)}${suffix}`;
}

function badId() {
  return NextResponse.json(
    { error: "Unknown repository" },
    { status: 400, headers: { "cache-control": "no-store" } },
  );
}

async function body(request: Request): Promise<RequestInit> {
  return {
    headers: { "content-type": "application/json" },
    body: await request.text(),
  };
}

/** The whole Repositories list, state included. Open to every role. */
export function handleCatalogList(workerProxy: WorkerProxy) {
  return forward(workerProxy, "/api/v1/repository-catalog", { method: "GET" });
}

/** One repository with the profile the engine currently resolves for it. */
export function handleCatalogEntryGet(id: string, workerProxy: WorkerProxy) {
  const path = repositoryPath(id);
  return path === null ? badId() : forward(workerProxy, path, { method: "GET" });
}

/** Saving a profile. The body travels untouched: the worker owns the role rule,
 *  the group-name refusal and the 409 for a repository that moved underneath an
 *  open screen. */
export async function handleCatalogEntryPut(
  id: string,
  request: Request,
  workerProxy: WorkerProxy,
) {
  const path = repositoryPath(id);
  if (path === null) return badId();
  return forward(workerProxy, path, { method: "PUT", ...(await body(request)) });
}

export async function handleCatalogEnabledPatch(
  id: string,
  request: Request,
  workerProxy: WorkerProxy,
) {
  const path = repositoryPath(id, "/enabled");
  if (path === null) return badId();
  return forward(workerProxy, path, { method: "PATCH", ...(await body(request)) });
}

export function handleCatalogVersionsGet(id: string, workerProxy: WorkerProxy) {
  const path = repositoryPath(id, "/versions");
  return path === null ? badId() : forward(workerProxy, path, { method: "GET" });
}

/** Ending the bridge. The 409 naming the repositories the admin has not
 *  acknowledged is the dialog's normal first answer, so it is passed through
 *  like any other status rather than raised. */
export async function handleCatalogActivate(
  request: Request,
  workerProxy: WorkerProxy,
) {
  return forward(workerProxy, "/api/v1/repository-catalog/activate", {
    method: "POST",
    ...(await body(request)),
  });
}

export async function handleCatalogImportPreview(
  request: Request,
  workerProxy: WorkerProxy,
) {
  return forward(workerProxy, "/api/v1/repository-catalog/import-preview", {
    method: "POST",
    ...(await body(request)),
  });
}

export async function handleCatalogImport(
  request: Request,
  workerProxy: WorkerProxy,
) {
  return forward(workerProxy, "/api/v1/repository-catalog/import", {
    method: "POST",
    ...(await body(request)),
  });
}

/**
 * Asking for a suggestion.
 *
 * The only handler here that moves the timeout. Everything else answers in
 * milliseconds; this one waits on a model.
 */
export async function handleCatalogSuggest(
  request: Request,
  workerProxy: WorkerProxy,
) {
  return forward(
    workerProxy,
    "/api/v1/repository-catalog/suggest",
    { method: "POST", ...(await body(request)) },
    SUGGEST_TIMEOUT_MS,
  );
}
