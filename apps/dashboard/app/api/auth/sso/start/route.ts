import { NextResponse } from "next/server";

import { fetchAuthWorker, readWorkerJson } from "@/lib/auth/worker";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const inviteId = url.searchParams.get("inviteId")?.trim();
  const workerPath = inviteId
    ? `/api/dashboard-auth/sso/start?inviteId=${encodeURIComponent(inviteId)}`
    : "/api/dashboard-auth/sso/start";
  const res = await fetchAuthWorker(workerPath);
  if (!res?.ok) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const body = await readWorkerJson<{ url?: string }>(res);
  if (!body.url) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  return NextResponse.redirect(body.url);
}
