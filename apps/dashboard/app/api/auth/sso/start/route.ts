import { NextResponse } from "next/server";

const BASE = process.env.WORKER_BASE_URL ?? "";

export async function GET(req: Request) {
  const res = await fetch(`${BASE}/api/dashboard-auth/sso/start`);
  if (!res.ok) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const body = (await res.json().catch(() => ({}))) as { url?: string };
  if (!body.url) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  return NextResponse.redirect(body.url);
}
