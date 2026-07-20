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

export async function handleDefinitionDeploy(
  req: Request,
  context: IdRouteContext,
  workerProxy: WorkerProxy,
) {
  return forwardJsonAction(req, context, workerProxy, "deploy", "POST");
}

export async function handleDefinitionRollback(
  req: Request,
  context: IdRouteContext,
  workerProxy: WorkerProxy,
) {
  return forwardJsonAction(req, context, workerProxy, "rollback", "POST");
}

export async function handleDefinitionValidate(
  req: Request,
  context: IdRouteContext,
  workerProxy: WorkerProxy,
) {
  return forwardJsonAction(req, context, workerProxy, "validate", "POST");
}

export async function handleDefinitionLayout(
  req: Request,
  context: IdRouteContext,
  workerProxy: WorkerProxy,
) {
  return forwardJsonAction(req, context, workerProxy, "layout", "PATCH");
}

async function forwardJsonAction(
  req: Request,
  { params }: IdRouteContext,
  workerProxy: WorkerProxy,
  action: string,
  method: "POST" | "PATCH",
) {
  return forward(workerProxy, `${await definitionPath(params)}/${action}`, {
    method,
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
    const headers = new Headers();
    const contentType = res.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    return new NextResponse(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
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
