import { NextResponse } from "next/server";

import { setSessionCookie } from "@/lib/auth/session-cookie";

const BASE = process.env.WORKER_BASE_URL ?? "";

export async function POST(req: Request) {
  const { inviteId, name, password } = (await req.json()) as {
    inviteId?: string;
    name?: string;
    password?: string;
  };
  if (!inviteId || !password) {
    return NextResponse.json(
      { error: "Invite and password required" },
      { status: 400 },
    );
  }

  const res = await fetch(`${BASE}/api/dashboard-auth/invite/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inviteId, name, password }),
  });

  const body = (await res.json().catch(() => ({}))) as {
    token?: string;
    error?: string;
    message?: string;
  };
  if (!res.ok) {
    return NextResponse.json(
      { error: body.error ?? body.message ?? "Unable to accept invite" },
      { status: res.status },
    );
  }
  if (!body.token) {
    return NextResponse.json({ error: "Auth misconfigured" }, { status: 502 });
  }

  await setSessionCookie(body.token);
  return NextResponse.json({ ok: true });
}
