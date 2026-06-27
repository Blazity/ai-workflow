import { NextResponse } from "next/server";

import { setSessionCookie } from "@/lib/auth/session-cookie";
import {
  authWorkerUnavailable,
  postAuthWorkerJson,
  readJsonBody,
  readWorkerJson,
} from "@/lib/auth/worker";

export async function POST(req: Request) {
  const body = await readJsonBody<{ email?: string; password?: string }>(req);

  const { email, password } = body;
  if (!email || !password) {
    return NextResponse.json(
      { error: "Email and password required" },
      { status: 400 },
    );
  }

  const res = await postAuthWorkerJson("/api/auth/sign-in/email", { email, password });
  if (!res) return authWorkerUnavailable("Unable to reach auth service");

  if (!res.ok) {
    if (res.status === 400 || res.status === 401) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }
    return NextResponse.json({ error: "Auth service unavailable" }, { status: 502 });
  }

  const responseBody = await readWorkerJson<{ token?: string }>(res);
  const token = res.headers.get("set-auth-token") ?? responseBody.token;
  if (!token) {
    return NextResponse.json({ error: "Auth misconfigured" }, { status: 502 });
  }

  await setSessionCookie(token);
  return NextResponse.json({ ok: true });
}
