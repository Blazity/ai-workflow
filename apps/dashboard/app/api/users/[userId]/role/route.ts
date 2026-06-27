import { NextResponse } from "next/server";

import { proxyWorker } from "@/lib/api/proxy";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  const body = await req.text();
  const res = await proxyWorker(`/api/v1/users/${encodeURIComponent(userId)}/role`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body,
  });

  return NextResponse.json(await res.json().catch(() => ({})), {
    status: res.status,
  });
}
