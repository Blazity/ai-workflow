import { NextResponse } from "next/server";

type WorkerProxy = (path: string, init?: RequestInit) => Promise<Response>;
type IdRouteContext = { params: Promise<{ id: string }> };
type IdVersionRouteContext = { params: Promise<{ id: string; version: string }> };

const LIST_QUERY_KEYS = ["q", "tag", "includeArchived"] as const;

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
  return forward(workerProxy, await promptPath(params), { method: "GET" });
}

export async function handlePromptPut(
  req: Request,
  { params }: IdRouteContext,
  workerProxy: WorkerProxy,
) {
  return forward(workerProxy, await promptPath(params), {
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
  return forward(workerProxy, await promptPath(params), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: await req.text(),
  });
}

export async function handlePromptDelete(
  { params }: IdRouteContext,
  workerProxy: WorkerProxy,
) {
  return forward(workerProxy, await promptPath(params), { method: "DELETE" });
}

export async function handlePromptRestore(
  req: Request,
  { params }: IdRouteContext,
  workerProxy: WorkerProxy,
) {
  return forward(workerProxy, `${await promptPath(params)}/restore`, {
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
  const path = `/api/v1/prompt-library/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`;
  return forward(workerProxy, path, { method: "GET" });
}

export async function handlePromptUsageGet(
  { params }: IdRouteContext,
  workerProxy: WorkerProxy,
) {
  return forward(workerProxy, `${await promptPath(params)}/usage`, { method: "GET" });
}

async function promptPath(params: Promise<{ id: string }>): Promise<string> {
  const { id } = await params;
  return `/api/v1/prompt-library/${encodeURIComponent(id)}`;
}

async function forward(workerProxy: WorkerProxy, path: string, init: RequestInit) {
  try {
    const res = await workerProxy(path, init);
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
