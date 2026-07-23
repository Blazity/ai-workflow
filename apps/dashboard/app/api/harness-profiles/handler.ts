import { NextResponse } from "next/server";

type WorkerProxy = (path: string, init?: RequestInit) => Promise<Response>;
type ProfileRouteContext = { params: Promise<{ id: string }> };

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

function notFound() {
  return NextResponse.json(
    { error: "Not found" },
    { status: 404, headers: { "cache-control": "no-store" } },
  );
}

async function profilePath(
  params: Promise<{ id: string }>,
): Promise<string | null> {
  const { id } = await params;
  return SAFE_ID.test(id)
    ? `/api/v1/harness-profiles/${encodeURIComponent(id)}`
    : null;
}

async function forward(
  workerProxy: WorkerProxy,
  path: string,
  init: RequestInit,
) {
  try {
    const response = await workerProxy(path, init);
    if (
      response.status === 204 ||
      response.status === 205 ||
      response.status === 304
    ) {
      return new NextResponse(null, {
        status: response.status,
        headers: { "cache-control": "no-store" },
      });
    }
    return NextResponse.json(await response.json().catch(() => ({})), {
      status: response.status,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (isWorkerTimeoutError(error)) {
      return NextResponse.json(
        { error: "Worker request timed out" },
        { status: 504, headers: { "cache-control": "no-store" } },
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

function jsonMutation(
  request: Request,
  path: string,
  workerProxy: WorkerProxy,
) {
  return request.text().then((body) =>
    forward(workerProxy, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
}

export function handleHarnessProfilesGet(
  request: Request,
  workerProxy: WorkerProxy,
) {
  const includeArchived = new URL(request.url).searchParams.get(
    "includeArchived",
  );
  const path =
    includeArchived === "1" || includeArchived === "true"
      ? "/api/v1/harness-profiles?includeArchived=1"
      : "/api/v1/harness-profiles";
  return forward(workerProxy, path, { method: "GET" });
}

export async function handleHarnessProfilesPost(
  request: Request,
  workerProxy: WorkerProxy,
) {
  return jsonMutation(
    request,
    "/api/v1/harness-profiles",
    workerProxy,
  );
}

export async function handleHarnessProfileGet(
  request: Request,
  { params }: ProfileRouteContext,
  workerProxy: WorkerProxy,
) {
  const path = await profilePath(params);
  if (!path) return notFound();
  const requestedVersion = new URL(request.url).searchParams.get("version");
  const versionQuery =
    requestedVersion && /^[1-9]\d*$/.test(requestedVersion)
      ? `?version=${requestedVersion}`
      : "";
  return forward(workerProxy, `${path}${versionQuery}`, { method: "GET" });
}

export async function handleHarnessProfilePatch(
  request: Request,
  { params }: ProfileRouteContext,
  workerProxy: WorkerProxy,
) {
  const path = await profilePath(params);
  if (!path) return notFound();
  return forward(workerProxy, path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: await request.text(),
  });
}

export async function handleHarnessProfileAction(
  request: Request,
  { params }: ProfileRouteContext,
  action: "publish" | "fork" | "restore" | "archive" | "skills/refresh",
  workerProxy: WorkerProxy,
) {
  const path = await profilePath(params);
  if (!path) return notFound();
  return jsonMutation(request, `${path}/${action}`, workerProxy);
}

export function handleHarnessSkillAction(
  request: Request,
  action: "discover" | "import",
  workerProxy: WorkerProxy,
) {
  return jsonMutation(
    request,
    `/api/v1/harness-skills/${action}`,
    workerProxy,
  );
}
