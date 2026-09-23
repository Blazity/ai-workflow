import { NextResponse } from "next/server";
import { isWorkerTimeout } from "@/lib/api/worker-errors";

export type WorkerProxy = (path: string, init?: RequestInit) => Promise<Response>;

/** A worker identifier as a path segment: run, attempt, briefing, round. */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

export function notFound() {
  return NextResponse.json(
    { error: "Not found" },
    { status: 404, headers: { "cache-control": "no-store" } },
  );
}

/** A query parameter the worker would refuse anyway, refused here. */
export function badRequest(message: string) {
  return NextResponse.json(
    { error: message },
    { status: 400, headers: { "cache-control": "no-store" } },
  );
}

/** Forwards one request to the worker and hands its JSON body and status back
 *  verbatim; a worker that does not answer in time is a 504. A `body` is sent
 *  as the JSON it came in as: the worker owns what a body may say. */
export async function forward(
  workerProxy: WorkerProxy,
  path: string,
  method: "GET" | "POST" | "PATCH" = "GET",
  body?: string,
) {
  try {
    const response = await workerProxy(
      path,
      body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body },
    );
    return NextResponse.json(await response.json().catch(() => ({})), {
      status: response.status,
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    if (isWorkerTimeout(error)) {
      return NextResponse.json(
        { error: "Worker request timed out" },
        {
          status: 504,
          headers: { "cache-control": "private, no-store" },
        },
      );
    }
    throw error;
  }
}
