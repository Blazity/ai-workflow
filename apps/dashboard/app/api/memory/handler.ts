import { NextResponse } from "next/server";
import { isWorkerTimeout } from "@/lib/api/worker-errors";

type WorkerProxy = (path: string, init?: RequestInit) => Promise<Response>;

/** The dashboard never touches the database: deleting a memory document is
 *  forwarded to the worker, which owns the auth and role checks. Both key parts
 *  are re-encoded here so a hostile value stays inside one query parameter. */
export async function handleMemoryDelete(req: Request, workerProxy: WorkerProxy) {
  const params = new URL(req.url).searchParams;
  const subjectKey = params.get("subjectKey");
  const docPath = params.get("docPath");
  if (!subjectKey || !docPath) {
    return NextResponse.json(
      { error: "subjectKey and docPath are required" },
      { status: 400 },
    );
  }

  const path = `/api/v1/memory?subjectKey=${encodeURIComponent(subjectKey)}&docPath=${encodeURIComponent(docPath)}`;
  try {
    const res = await workerProxy(path, { method: "DELETE" });
    return NextResponse.json(await res.json().catch(() => ({})), { status: res.status });
  } catch (error) {
    if (isWorkerTimeout(error)) {
      return NextResponse.json({ error: "Worker request timed out" }, { status: 504 });
    }
    throw error;
  }
}
