import { NextResponse } from "next/server";

import { proxyWorker } from "@/lib/api/proxy";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ inviteId: string }> },
) {
  const { inviteId } = await params;
  const res = await proxyWorker(
    `/api/v1/invites/${encodeURIComponent(inviteId)}/cancel`,
    { method: "POST" },
  );

  return NextResponse.json(await res.json().catch(() => ({})), {
    status: res.status,
  });
}
