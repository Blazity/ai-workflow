import { NextResponse } from "next/server";

const BASE = process.env.WORKER_BASE_URL ?? "";
const WORKER_TIMEOUT_MS = 10_000;

export async function POST(req: Request) {
  let body: { email?: string };
  try {
    body = (await req.json()) as { email?: string };
  } catch {
    body = {};
  }

  const { email } = body;
  if (!email) {
    return NextResponse.json({ error: "Email required" }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/auth/request-password-reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
    });
  } catch {
    return NextResponse.json(
      { error: "Unable to send reset link" },
      { status: 502 },
    );
  }

  if (!res.ok) {
    return NextResponse.json(
      { error: "Unable to send reset link" },
      { status: res.status >= 500 ? 502 : res.status },
    );
  }

  return NextResponse.json({ ok: true });
}
