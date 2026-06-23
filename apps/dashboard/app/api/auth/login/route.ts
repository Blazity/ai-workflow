import { NextResponse } from "next/server";
import { cookies } from "next/headers";

const BASE = process.env.WORKER_BASE_URL ?? "";
const SEVEN_DAYS = 60 * 60 * 24 * 7;

export async function POST(req: Request) {
  const { email, password } = (await req.json()) as {
    email?: string;
    password?: string;
  };
  if (!email || !password) {
    return NextResponse.json(
      { error: "Email and password required" },
      { status: 400 },
    );
  }

  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const body = (await res.json().catch(() => ({}))) as { token?: string };
  const token = res.headers.get("set-auth-token") ?? body.token;
  if (!token) {
    return NextResponse.json({ error: "Auth misconfigured" }, { status: 502 });
  }

  (await cookies()).set("ba_session", token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SEVEN_DAYS,
  });
  return NextResponse.json({ ok: true });
}
