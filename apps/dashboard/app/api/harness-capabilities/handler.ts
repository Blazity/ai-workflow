import { NextResponse } from "next/server";

type WorkerProxy = (path: string, init?: RequestInit) => Promise<Response>;

export async function handleHarnessCapabilitiesGet(
  request: Request,
  workerProxy: WorkerProxy,
) {
  const source = new URL(request.url);
  const provider = source.searchParams.get("provider");
  const cliVersion = source.searchParams.get("cliVersion");
  const refresh = source.searchParams.get("refresh");
  if (
    (provider !== "claude" && provider !== "codex") ||
    !cliVersion ||
    !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(cliVersion)
  ) {
    return NextResponse.json(
      { error: "Invalid capability request" },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  const query = new URLSearchParams({ provider, cliVersion });
  if (refresh === "1" || refresh === "true") {
    query.set("refresh", "true");
  }
  try {
    const response = await workerProxy(
      `/api/v1/harness-capabilities?${query.toString()}`,
      { method: "GET" },
    );
    return NextResponse.json(await response.json().catch(() => ({})), {
      status: response.status,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    const candidate = error as { name?: unknown; code?: unknown };
    if (candidate.name === "TimeoutError" || candidate.code === 23) {
      return NextResponse.json(
        { error: "Worker request timed out" },
        { status: 504, headers: { "cache-control": "no-store" } },
      );
    }
    throw error;
  }
}
