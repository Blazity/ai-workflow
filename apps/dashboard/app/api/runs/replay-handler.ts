import { NextResponse } from "next/server";

type WorkerProxy = (path: string, init?: RequestInit) => Promise<Response>;
type ReplayRouteContext = { params: Promise<{ runId: string }> };
type AttemptRouteContext = {
  params: Promise<{ runId: string; attemptId: string }>;
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

function notFound() {
  return NextResponse.json(
    { error: "Not found" },
    { status: 404, headers: { "cache-control": "no-store" } },
  );
}

async function forward(workerProxy: WorkerProxy, path: string) {
  try {
    const response = await workerProxy(path, { method: "GET" });
    return NextResponse.json(await response.json().catch(() => ({})), {
      status: response.status,
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    if (isWorkerTimeoutError(error)) {
      return NextResponse.json(
        { error: "Worker request timed out" },
        {
          status: 504,
          headers: { "cache-control": "private, no-store" },
        },
      );
    }
    throw error;
  }
}

function isWorkerTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; name?: unknown };
  return candidate.name === "TimeoutError" || candidate.code === 23;
}

function replayQuery(request: Request): string {
  const searchParams = new URL(request.url).searchParams;
  const rawLimit = searchParams.get("limit");
  const requested =
    rawLimit === null || rawLimit.trim() === "" ? Number.NaN : Number(rawLimit);
  const limit =
    Number.isFinite(requested) && requested > 0
      ? Math.min(200, Math.trunc(requested))
      : 100;
  const cursor = searchParams.get("cursor");
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set("cursor", cursor);
  return query.toString();
}

export async function handleRunReplayGet(
  request: Request,
  { params }: ReplayRouteContext,
  workerProxy: WorkerProxy,
) {
  const { runId } = await params;
  if (!SAFE_ID.test(runId)) return notFound();
  return forward(
    workerProxy,
    `/api/v1/runs/${encodeURIComponent(runId)}/replay?${replayQuery(request)}`,
  );
}

export async function handleRunAttemptGet(
  { params }: AttemptRouteContext,
  workerProxy: WorkerProxy,
) {
  const { runId, attemptId } = await params;
  if (!SAFE_ID.test(runId) || !SAFE_ID.test(attemptId)) return notFound();
  return forward(
    workerProxy,
    `/api/v1/runs/${encodeURIComponent(runId)}/attempts/${encodeURIComponent(attemptId)}`,
  );
}
