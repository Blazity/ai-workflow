import { NextResponse } from "next/server";

const BASE = process.env.WORKER_BASE_URL ?? "";

export async function POST(req: Request) {
  const { token, password } = (await req.json()) as {
    token?: string;
    password?: string;
  };
  if (!token || !password) {
    return NextResponse.json(
      { error: "Token and password required" },
      { status: 400 },
    );
  }

  const res = await fetch(`${BASE}/api/auth/reset-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, newPassword: password }),
  });

  if (!res.ok) {
    return NextResponse.json(
      { error: "This reset link is invalid or expired" },
      { status: 400 },
    );
  }

  return NextResponse.json({ ok: true });
}
