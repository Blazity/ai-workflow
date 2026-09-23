import { NextResponse } from "next/server";
import { isWorkerTimeout } from "@/lib/api/worker-errors";

type WorkerProxy = (path: string, init?: RequestInit) => Promise<Response>;

/** Client-fetchable read of the tenant's saved config, used by the run_scripts
 *  block panel to offer configured group names instead of free text alone. */
export async function handlePrePrChecksGet(workerProxy: WorkerProxy) {
  return forward(workerProxy, "/api/v1/pre-pr-checks", { method: "GET" });
}

export async function handleRepositoriesGet(workerProxy: WorkerProxy) {
  return forward(workerProxy, "/api/v1/repositories", { method: "GET" });
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
