import { NextResponse } from "next/server";

import { proxyWorker } from "@/lib/api/proxy";

export async function POST(req: Request) {
  const body = await req.text();
  const res = await proxyWorker("/api/v1/invites", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

  return NextResponse.json(await res.json().catch(() => ({})), {
    status: res.status,
  });
}
