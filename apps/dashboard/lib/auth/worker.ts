import "server-only";

import { NextResponse } from "next/server";

const BASE = process.env.WORKER_BASE_URL ?? "";
const WORKER_TIMEOUT_MS = 10_000;

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
  try {
    return await fetch(`${BASE}${path}`, {
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
