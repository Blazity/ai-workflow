import { NextResponse } from "next/server";

type WorkerProxy = (path: string, init?: RequestInit) => Promise<Response>;

export async function handlePrePrChecksGet(workerProxy: WorkerProxy) {
  return forward(workerProxy, "/api/v1/pre-pr-checks", { method: "GET" });
}

export async function handlePrePrChecksPut(req: Request, workerProxy: WorkerProxy) {
  return forward(workerProxy, "/api/v1/pre-pr-checks", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: await req.text(),
  });
}

export async function handlePrePrChecksRestore(req: Request, workerProxy: WorkerProxy) {
  return forward(workerProxy, "/api/v1/pre-pr-checks/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await req.text(),
  });
}

export async function handleRepositoriesGet(workerProxy: WorkerProxy) {
  return forward(workerProxy, "/api/v1/repositories", { method: "GET" });
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
