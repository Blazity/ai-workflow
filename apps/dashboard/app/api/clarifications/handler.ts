import { NextResponse } from "next/server";
import { isWorkerTimeout } from "@/lib/api/worker-errors";

type WorkerProxy = (path: string, init?: RequestInit) => Promise<Response>;
type IdRouteContext = { params: Promise<{ id: string }> };

export async function handleClarificationAnswer(
  req: Request,
  { params }: IdRouteContext,
  workerProxy: WorkerProxy,
) {
  const { id } = await params;
  const body = await req.text();
  return forward(
    workerProxy,
    `/api/v1/clarifications/${encodeURIComponent(id)}/answer`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    },
  );
}

async function forward(workerProxy: WorkerProxy, path: string, init: RequestInit) {
  try {
    const res = await workerProxy(path, init);
    return NextResponse.json(await res.json().catch(() => ({})), { status: res.status });
  } catch (error) {
    if (isWorkerTimeout(error)) {
      return NextResponse.json({ error: "Worker request timed out" }, { status: 504 });
    }
    throw error;
  }
}
