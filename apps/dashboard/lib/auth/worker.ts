import "server-only";

import { NextResponse } from "next/server";
import { fetchWorker } from "./worker-core";

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
  return fetchWorker(process.env.WORKER_BASE_URL, path, init);
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
