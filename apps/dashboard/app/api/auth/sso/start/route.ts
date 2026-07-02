import { NextResponse } from "next/server";

import { workerUrl } from "@/lib/auth/worker-core";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const inviteId = url.searchParams.get("inviteId")?.trim();
  const workerPath = inviteId
    ? `/api/dashboard-auth/sso/start?inviteId=${encodeURIComponent(inviteId)}`
    : "/api/dashboard-auth/sso/start";
  try {
    return NextResponse.redirect(workerUrl(process.env.WORKER_BASE_URL, workerPath));
  } catch {
    return NextResponse.redirect(new URL("/login", req.url));
  }
}
