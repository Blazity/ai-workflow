// apps/dashboard/app/api/integrations/handler.ts
//
// The browser half of the integrations API, shaped exactly like
// app/api/repository-catalog/handler.ts: the session travels through
// proxyWorker, the worker's status and body come back verbatim, and a worker
// that never answers becomes a 504 rather than an unhandled rejection.
//
// Nothing here decides a role and nothing here decides a status. The worker
// refuses a member's write with a 403, refuses a deployment that does not own
// its database with a 403, and answers a stale save with a 409 body; each of
// those is what the screen renders, so a second copy of the rule cannot drift
// away from the one that is enforced.
import { INTEGRATION_ID } from "@shared/contracts";
import { NextResponse } from "next/server";

type WorkerProxy = (
  path: string,
  init?: RequestInit,
  timeoutMs?: number,
) => Promise<Response>;

/**
 * How long a call that contacts the provider is given.
 *
 * The worker bounds a connection test at 20 seconds
 * (`TEST_TIMEOUT_MS`, apps/worker/src/services/integrations/authoring.ts), and
 * both saving and testing run one. proxyWorker's default ceiling is 10, so a
 * slow but healthy provider would have handed the admin a failure that never
 * happened and sent them off to rotate a perfectly good token. This sits above
 * the worker's own ceiling, so the answer an admin reads is always the
 * provider's and never the proxy's.
 */
export const INTEGRATION_TEST_TIMEOUT_MS = 30_000;

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
 * An integration id as it may appear in a path segment.
 *
 * `INTEGRATION_ID`, the one rule the worker's route helper also reads,
 * re-encoded on the way out, so a hostile segment cannot leave the segment it
 * is in and add a path of its own to the worker URL.
 */
function integrationPath(id: string, suffix = ""): string | null {
  if (!INTEGRATION_ID.test(id)) return null;
  return `/api/v1/integrations/${encodeURIComponent(id)}${suffix}`;
}

function badId() {
  return NextResponse.json(
    { error: "Unknown integration" },
    { status: 400, headers: { "cache-control": "no-store" } },
  );
}

async function body(request: Request): Promise<RequestInit> {
  return {
    headers: { "content-type": "application/json" },
    body: await request.text(),
  };
}

/** Every integration this build ships and what state it is in. Open to every role. */
export function handleIntegrationsList(workerProxy: WorkerProxy) {
  return forward(workerProxy, "/api/v1/integrations", { method: "GET" });
}

/** Store values. The worker tests them before they become the ones in use, so
 *  this call waits on the provider and carries the longer ceiling. */
export async function handleIntegrationConnectionPut(
  id: string,
  request: Request,
  workerProxy: WorkerProxy,
) {
  const path = integrationPath(id, "/connection");
  if (path === null) return badId();
  return forward(
    workerProxy,
    path,
    { method: "PUT", ...(await body(request)) },
    INTEGRATION_TEST_TIMEOUT_MS,
  );
}

/** Ask the provider about the configuration in use right now. Takes no body. */
export function handleIntegrationTest(id: string, workerProxy: WorkerProxy) {
  const path = integrationPath(id, "/test");
  if (path === null) return badId();
  return forward(
    workerProxy,
    path,
    { method: "POST" },
    INTEGRATION_TEST_TIMEOUT_MS,
  );
}

/** The kill switch. Mints no version and contacts no provider. */
export async function handleIntegrationEnabledPatch(
  id: string,
  request: Request,
  workerProxy: WorkerProxy,
) {
  const path = integrationPath(id, "/enabled");
  if (path === null) return badId();
  return forward(workerProxy, path, { method: "PATCH", ...(await body(request)) });
}

/** Switch which source is live. Refused by the worker when the target is not
 *  complete, with the sentence that names what is missing. */
export async function handleIntegrationSourcePatch(
  id: string,
  request: Request,
  workerProxy: WorkerProxy,
) {
  const path = integrationPath(id, "/source");
  if (path === null) return badId();
  return forward(workerProxy, path, { method: "PATCH", ...(await body(request)) });
}

/** Forget every stored value and every stored secret in every past version. */
export function handleIntegrationConnectionDelete(id: string, workerProxy: WorkerProxy) {
  const path = integrationPath(id, "/connection");
  if (path === null) return badId();
  return forward(workerProxy, path, { method: "DELETE" });
}
