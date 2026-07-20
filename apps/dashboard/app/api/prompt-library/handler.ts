import { NextResponse } from "next/server";

type WorkerProxy = (path: string, init?: RequestInit) => Promise<Response>;
type IdRouteContext = { params: Promise<{ id: string }> };
type IdVersionRouteContext = { params: Promise<{ id: string; version: string }> };

const LIST_QUERY_KEYS = ["q", "tag", "includeArchived"] as const;

// Prompt ids and versions are numeric by contract; rejecting anything else
// before forwarding blocks path-rewrite attempts (e.g. "..") reaching the worker.
const NUMERIC_ID = /^\d+$/;

function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function handlePromptsList(req: Request, workerProxy: WorkerProxy) {
  const incoming = new URL(req.url).searchParams;
  const forwarded = new URLSearchParams();
  for (const key of LIST_QUERY_KEYS) {
    const value = incoming.get(key);
    if (value !== null) forwarded.set(key, value);
  }
  const query = forwarded.toString();
  return forward(workerProxy, `/api/v1/prompt-library${query ? `?${query}` : ""}`, {
    method: "GET",
  });
}

export async function handlePromptsCreate(req: Request, workerProxy: WorkerProxy) {
  return forward(workerProxy, "/api/v1/prompt-library", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await req.text(),
  });
}

export async function handlePromptGet(
  { params }: IdRouteContext,
  workerProxy: WorkerProxy,
) {
  const path = await promptPath(params);
  if (path === null) return notFound();
  return forward(workerProxy, path, { method: "GET" });
}

export async function handlePromptPut(
  req: Request,
  { params }: IdRouteContext,
  workerProxy: WorkerProxy,
) {
  const path = await promptPath(params);
  if (path === null) return notFound();
  return forward(workerProxy, path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: await req.text(),
  });
}

export async function handlePromptPatch(
  req: Request,
  { params }: IdRouteContext,
  workerProxy: WorkerProxy,
) {
  const path = await promptPath(params);
  if (path === null) return notFound();
  return forward(workerProxy, path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: await req.text(),
  });
}

export async function handlePromptDelete(
  { params }: IdRouteContext,
  workerProxy: WorkerProxy,
) {
  const path = await promptPath(params);
  if (path === null) return notFound();
  return forward(workerProxy, path, { method: "DELETE" });
}

export async function handlePromptRestore(
  req: Request,
  { params }: IdRouteContext,
  workerProxy: WorkerProxy,
) {
  const path = await promptPath(params);
  if (path === null) return notFound();
  return forward(workerProxy, `${path}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await req.text(),
  });
}

export async function handlePromptVersionGet(
  { params }: IdVersionRouteContext,
  workerProxy: WorkerProxy,
) {
  const { id, version } = await params;
  if (!NUMERIC_ID.test(id) || !NUMERIC_ID.test(version)) return notFound();
  const path = `/api/v1/prompt-library/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`;
  return forward(workerProxy, path, { method: "GET" });
}

export async function handlePromptUsageGet(
  { params }: IdRouteContext,
  workerProxy: WorkerProxy,
) {
  const path = await promptPath(params);
  if (path === null) return notFound();
  return forward(workerProxy, `${path}/usage`, { method: "GET" });
}

async function promptPath(params: Promise<{ id: string }>): Promise<string | null> {
  const { id } = await params;
  if (!NUMERIC_ID.test(id)) return null;
  return `/api/v1/prompt-library/${encodeURIComponent(id)}`;
}

async function forward(workerProxy: WorkerProxy, path: string, init: RequestInit) {
  try {
    const res = await workerProxy(path, init);
    // 204/205/304 carry no body; re-serializing them as JSON would be invalid.
    if (res.status === 204 || res.status === 205 || res.status === 304) {
      return new NextResponse(null, { status: res.status });
    }
    return NextResponse.json(await res.json().catch(() => ({})), { status: res.status });
  } catch (error) {
    if (isWorkerTimeoutError(error)) {
      return NextResponse.json({ error: "Worker request timed out" }, { status: 504 });
    }
    throw error;
  }
}

function isWorkerTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { code?: unknown; name?: unknown };
  return maybeError.name === "TimeoutError" || maybeError.code === 23;
}
