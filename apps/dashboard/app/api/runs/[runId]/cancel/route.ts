import { NextResponse } from "next/server";
import { proxyWorker } from "@/lib/api/proxy";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const response = await proxyWorker(
    `/api/v1/runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" },
  );
  return NextResponse.json(await response.json().catch(() => ({})), {
    status: response.status,
  });
}
