import { NextResponse } from "next/server";

import { setSessionCookie } from "@/lib/auth/session-cookie";

const BASE = process.env.WORKER_BASE_URL ?? "";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const handoffToken = url.searchParams.get("token");
  if (!handoffToken) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const res = await fetch(`${BASE}/api/dashboard-auth/sso/consume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: handoffToken }),
  });
  if (!res.ok) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const body = (await res.json().catch(() => ({}))) as { sessionToken?: string };
  if (!body.sessionToken) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  await setSessionCookie(body.sessionToken);
  return NextResponse.redirect(new URL("/", req.url));
}
