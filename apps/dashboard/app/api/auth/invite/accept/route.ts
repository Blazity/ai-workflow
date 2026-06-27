import { NextResponse } from "next/server";

import { setSessionCookie } from "@/lib/auth/session-cookie";
import {
  authWorkerUnavailable,
  postAuthWorkerJson,
  readJsonBody,
  readWorkerJson,
} from "@/lib/auth/worker";

export async function POST(req: Request) {
  const body = await readJsonBody<{
    inviteId?: string;
    name?: string;
    password?: string;
  }>(req);

  const { inviteId, name, password } = body;
  if (!inviteId || !password) {
    return NextResponse.json(
      { error: "Invite and password required" },
      { status: 400 },
    );
  }

  const res = await postAuthWorkerJson("/api/dashboard-auth/invite/accept", {
    inviteId,
    name,
    password,
  });
  if (!res) return authWorkerUnavailable("Unable to accept invite");

  const responseBody = await readWorkerJson<{
    token?: string;
    error?: string;
    message?: string;
  }>(res);
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
