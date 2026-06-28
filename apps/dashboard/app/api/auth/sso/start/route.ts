import { NextResponse } from "next/server";

import { fetchAuthWorker, readWorkerJson } from "@/lib/auth/worker";

export async function GET(req: Request) {
  const res = await fetchAuthWorker("/api/dashboard-auth/sso/start");
  if (!res?.ok) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const body = await readWorkerJson<{ url?: string }>(res);
  if (!body.url) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  return NextResponse.redirect(body.url);
}
