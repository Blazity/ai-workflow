import { SAFE_ID, forward, notFound, type WorkerProxy } from "../worker-forward";

type ReplayRouteContext = { params: Promise<{ runId: string }> };
type AttemptRouteContext = {
  params: Promise<{ runId: string; attemptId: string }>;
};

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

export async function handleRunCancelPost(
  { params }: ReplayRouteContext,
  workerProxy: WorkerProxy,
) {
  const { runId } = await params;
  if (!SAFE_ID.test(runId)) return notFound();
  return forward(
    workerProxy,
    `/api/v1/runs/${encodeURIComponent(runId)}/cancel`,
    "POST",
  );
}
