import { NextResponse } from "next/server";

const BASE = process.env.WORKER_BASE_URL ?? "";
const WORKER_TIMEOUT_MS = 10_000;

export async function GET(req: Request) {
  try {
    const res = await fetch(`${BASE}/api/dashboard-auth/sso/start`, {
      signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
    });
    if (!res.ok) {
      return NextResponse.redirect(new URL("/login", req.url));
    }

    const body = (await res.json().catch(() => ({}))) as { url?: string };
    if (!body.url) {
      return NextResponse.redirect(new URL("/login", req.url));
    }

    return NextResponse.redirect(body.url);
  } catch {
    return NextResponse.redirect(new URL("/login", req.url));
  }
}
