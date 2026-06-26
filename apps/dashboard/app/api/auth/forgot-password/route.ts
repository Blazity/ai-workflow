import { NextResponse } from "next/server";

const BASE = process.env.WORKER_BASE_URL ?? "";

export async function POST(req: Request) {
  const { email } = (await req.json()) as { email?: string };
  if (!email) {
    return NextResponse.json({ error: "Email required" }, { status: 400 });
  }

  const res = await fetch(`${BASE}/api/auth/request-password-reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });

  if (!res.ok) {
    return NextResponse.json(
      { error: "Unable to send reset link" },
      { status: res.status >= 500 ? 502 : res.status },
    );
  }

  return NextResponse.json({ ok: true });
}
