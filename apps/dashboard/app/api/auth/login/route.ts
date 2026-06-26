import { NextResponse } from "next/server";

import { setSessionCookie } from "@/lib/auth/session-cookie";

const BASE = process.env.WORKER_BASE_URL ?? "";
const WORKER_TIMEOUT_MS = 10_000;

export async function POST(req: Request) {
  let body: { email?: string; password?: string };
  try {
    body = (await req.json()) as {
      email?: string;
      password?: string;
    };
  } catch {
    body = {};
  }

  const { email, password } = body;
  if (!email || !password) {
    return NextResponse.json(
      { error: "Email and password required" },
      { status: 400 },
    );
  }

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
    });
  } catch {
    return NextResponse.json(
      { error: "Unable to reach auth service" },
      { status: 502 },
    );
  }

  if (!res.ok) {
    if (res.status === 400 || res.status === 401) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }
    return NextResponse.json({ error: "Auth service unavailable" }, { status: 502 });
  }

  const responseBody = (await res.json().catch(() => ({}))) as { token?: string };
  const token = res.headers.get("set-auth-token") ?? responseBody.token;
  if (!token) {
    return NextResponse.json({ error: "Auth misconfigured" }, { status: 502 });
  }

  await setSessionCookie(token);
  return NextResponse.json({ ok: true });
}
