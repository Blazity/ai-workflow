import { NextResponse } from "next/server";
import { isWorkerTimeout } from "@/lib/api/worker-errors";

const ACTIVE_SCAN_TIMEOUT_MS = 15_000;

type WorkerProxy = (
  path: string,
  init?: RequestInit,
  timeoutMs?: number,
) => Promise<Response>;

export async function handleSystemHealthScan(proxy: WorkerProxy) {
  try {
    const response = await proxy(
      "/api/v1/system/health",
      { method: "POST" },
      ACTIVE_SCAN_TIMEOUT_MS,
    );
    return NextResponse.json(await response.json().catch(() => ({})), {
      status: response.status,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (isWorkerTimeout(error)) {
      return NextResponse.json(
        { error: "System health scan timed out" },
        { status: 504, headers: { "cache-control": "no-store" } },
      );
    }
    throw error;
  }
}
