import { NextResponse } from "next/server";

import { setSessionCookie } from "@/lib/auth/session-cookie";

const BASE = process.env.WORKER_BASE_URL ?? "";
const WORKER_TIMEOUT_MS = 10_000;

export async function POST(req: Request) {
  let body: { inviteId?: string; name?: string; password?: string };
  try {
    body = (await req.json()) as {
      inviteId?: string;
      name?: string;
      password?: string;
    };
  } catch {
    body = {};
  }

  const { inviteId, name, password } = body;
  if (!inviteId || !password) {
    return NextResponse.json(
      { error: "Invite and password required" },
      { status: 400 },
    );
  }

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/dashboard-auth/invite/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteId, name, password }),
      signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
    });
  } catch {
    return NextResponse.json(
      { error: "Unable to accept invite" },
      { status: 502 },
    );
  }

  const responseBody = (await res.json().catch(() => ({}))) as {
    token?: string;
    error?: string;
    message?: string;
  };
  if (!res.ok) {
    return NextResponse.json(
      { error: responseBody.error ?? responseBody.message ?? "Unable to accept invite" },
      { status: res.status },
    );
  }
  if (!responseBody.token) {
    return NextResponse.json({ error: "Auth misconfigured" }, { status: 502 });
  }

  await setSessionCookie(responseBody.token);
  return NextResponse.json({ ok: true });
}
