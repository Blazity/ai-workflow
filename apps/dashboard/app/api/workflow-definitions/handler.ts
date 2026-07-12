import { NextResponse } from "next/server";

type WorkerProxy = (path: string, init?: RequestInit) => Promise<Response>;
type IdRouteContext = { params: Promise<{ id: string }> };

export async function handleDefinitionsList(workerProxy: WorkerProxy) {
  return forward(workerProxy, "/api/v1/workflow-definitions", { method: "GET" });
}

export async function handleDefinitionsCreate(req: Request, workerProxy: WorkerProxy) {
  return forward(workerProxy, "/api/v1/workflow-definitions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await req.text(),
  });
}

export async function handleDefinitionGet(
  { params }: IdRouteContext,
  workerProxy: WorkerProxy,
) {
  return forward(workerProxy, await definitionPath(params), { method: "GET" });
}

export async function handleDefinitionPut(
  req: Request,
  { params }: IdRouteContext,
  workerProxy: WorkerProxy,
) {
  return forward(workerProxy, await definitionPath(params), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: await req.text(),
  });
}

export async function handleDefinitionPatch(
  req: Request,
  { params }: IdRouteContext,
  workerProxy: WorkerProxy,
) {
  return forward(workerProxy, await definitionPath(params), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: await req.text(),
  });
}

export async function handleDefinitionDelete(
  { params }: IdRouteContext,
  workerProxy: WorkerProxy,
) {
  return forward(workerProxy, await definitionPath(params), { method: "DELETE" });
}

export async function handleDefinitionRestore(
  req: Request,
  { params }: IdRouteContext,
  workerProxy: WorkerProxy,
) {
  return forward(workerProxy, `${await definitionPath(params)}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await req.text(),
  });
}

async function definitionPath(params: Promise<{ id: string }>): Promise<string> {
  const { id } = await params;
  return `/api/v1/workflow-definitions/${encodeURIComponent(id)}`;
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
