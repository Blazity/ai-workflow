import { NextResponse } from "next/server";

type RoleRouteContext = { params: Promise<{ userId: string }> };
type WorkerProxy = (path: string, init: RequestInit) => Promise<Response>;

export async function handleUserRolePatch(
  req: Request,
  { params }: RoleRouteContext,
  workerProxy: WorkerProxy,
) {
  const { userId } = await params;
  const body = await req.text();

  try {
    const res = await workerProxy(`/api/v1/users/${encodeURIComponent(userId)}/role`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body,
    });

    return NextResponse.json(await res.json().catch(() => ({})), {
      status: res.status,
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
