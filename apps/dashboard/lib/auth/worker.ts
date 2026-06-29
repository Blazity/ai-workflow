import "server-only";

import { NextResponse } from "next/server";

const BASE = process.env.WORKER_BASE_URL;
const WORKER_TIMEOUT_MS = 10_000;

function workerUrl(path: string): string {
  if (!BASE) {
    throw new Error("WORKER_BASE_URL is required for dashboard auth requests");
  }

  return `${BASE}${path}`;
}

export async function readJsonBody<T extends object>(
  req: Request,
): Promise<Partial<T>> {
  try {
    return (await req.json()) as Partial<T>;
  } catch {
    return {};
  }
}

export async function readWorkerJson<T>(res: Response): Promise<T> {
  return (await res.json().catch(() => ({}))) as T;
}

export async function fetchAuthWorker(
  path: string,
  init: RequestInit = {},
): Promise<Response | null> {
  const url = workerUrl(path);

  try {
    return await fetch(url, {
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

export function withRequestOrigin(
  req: Request,
  init: RequestInit = {},
): RequestInit {
  const headers = new Headers(init.headers);
  if (!headers.has("origin")) {
    headers.set("origin", req.headers.get("origin") ?? new URL(req.url).origin);
  }
  return { ...init, headers };
}

export async function postAuthWorkerJson(
  path: string,
  body: unknown,
  init: RequestInit = {},
): Promise<Response | null> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return fetchAuthWorker(path, {
    ...init,
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

export function authWorkerUnavailable(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 502 });
}
