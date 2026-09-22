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
import { NextResponse } from "next/server";

import { isWorkerTimeout } from "@/lib/api/worker-response-error";
import { PROVIDER_CALL_CEILING_MS } from "@/lib/integrations/provider-wait";

type WorkerProxy = (
  path: string,
  init?: RequestInit,
  timeoutMs?: number,
) => Promise<Response>;

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
    if (isWorkerTimeout(error)) {
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
 * The same shape the worker's own route helper accepts
 * (`apps/worker/src/routes/api/v1/integrations/route-id.ts`), re-encoded on the
 * way out, so a hostile segment cannot leave the segment it is in and add a
 * path of its own to the worker URL.
 */
function integrationPath(id: string, suffix = ""): string | null {
  if (!/^[a-z][a-z0-9]{2,31}$/.test(id)) return null;
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
 *  this call waits on the provider and carries the longer ceiling: proxyWorker's
 *  default of 10 seconds would hand the admin a failure that never happened. */
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
    PROVIDER_CALL_CEILING_MS,
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
    PROVIDER_CALL_CEILING_MS,
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
