import { NextResponse } from "next/server";

type WorkerProxy = (path: string, init?: RequestInit) => Promise<Response>;
type IdRouteContext = { params: Promise<{ id: string }> };

export async function handleApprovalsList(req: Request, workerProxy: WorkerProxy) {
  const status = new URL(req.url).searchParams.get("status");
  const path = status
    ? `/api/v1/approvals?status=${encodeURIComponent(status)}`
    : "/api/v1/approvals";
  return forward(workerProxy, path, { method: "GET" });
}

export async function handleApprovalApprove(
  { params }: IdRouteContext,
  workerProxy: WorkerProxy,
) {
  return forward(workerProxy, `${await approvalPath(params)}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
}

export async function handleApprovalReject(
  { params }: IdRouteContext,
  workerProxy: WorkerProxy,
) {
  return forward(workerProxy, `${await approvalPath(params)}/reject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
}

async function approvalPath(params: Promise<{ id: string }>): Promise<string> {
  const { id } = await params;
  return `/api/v1/approvals/${encodeURIComponent(id)}`;
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
