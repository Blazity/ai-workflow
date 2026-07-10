import { NextResponse } from "next/server";

type WorkerProxy = (path: string, init?: RequestInit) => Promise<Response>;

export async function handleWorkflowDefinitionGet(workerProxy: WorkerProxy) {
  return forward(workerProxy, "/api/v1/workflow-definition", { method: "GET" });
}

export async function handleWorkflowDefinitionPut(req: Request, workerProxy: WorkerProxy) {
  return forward(workerProxy, "/api/v1/workflow-definition", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: await req.text(),
  });
}

export async function handleWorkflowDefinitionRestore(req: Request, workerProxy: WorkerProxy) {
  return forward(workerProxy, "/api/v1/workflow-definition/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await req.text(),
  });
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
