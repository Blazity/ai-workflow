import { NextResponse } from "next/server";

const BASE = process.env.WORKER_BASE_URL ?? "";
const WORKER_TIMEOUT_MS = 10_000;

export async function POST(req: Request) {
  let body: { token?: string; password?: string };
  try {
    body = (await req.json()) as {
      token?: string;
      password?: string;
    };
  } catch {
    body = {};
  }

  const { token, password } = body;
  if (!token || !password) {
    return NextResponse.json(
      { error: "Token and password required" },
      { status: 400 },
    );
  }

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/auth/reset-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, newPassword: password }),
      signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
    });
  } catch {
    return NextResponse.json(
      { error: "Unable to reset password" },
      { status: 502 },
    );
  }

  if (!res.ok) {
    if (res.status >= 400 && res.status < 500) {
      return NextResponse.json(
        { error: "This reset link is invalid or expired" },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: "Unable to reset password" },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true });
}
