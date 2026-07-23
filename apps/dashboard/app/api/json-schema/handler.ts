import { NextResponse } from "next/server";

type WorkerProxy = (path: string, init?: RequestInit) => Promise<Response>;

export async function handleJsonSchemaInspect(
  req: Request,
  workerProxy: WorkerProxy,
) {
  try {
    const res = await workerProxy("/api/v1/json-schema/inspect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await req.text(),
    });
    return new NextResponse(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: {
        "cache-control": "private, no-store",
        "content-type": res.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      ((error as { name?: unknown }).name === "TimeoutError" ||
        (error as { code?: unknown }).code === 23)
    ) {
      return NextResponse.json(
        { error: "Worker request timed out" },
        { status: 504 },
      );
    }
    throw error;
  }
}
