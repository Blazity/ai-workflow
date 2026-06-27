import { NextResponse } from "next/server";

import {
  authWorkerUnavailable,
  postAuthWorkerJson,
  readJsonBody,
} from "@/lib/auth/worker";

export async function POST(req: Request) {
  const body = await readJsonBody<{ token?: string; password?: string }>(req);

  const { token, password } = body;
  if (!token || !password) {
    return NextResponse.json(
      { error: "Token and password required" },
      { status: 400 },
    );
  }

  const res = await postAuthWorkerJson("/api/auth/reset-password", {
    token,
    newPassword: password,
  });
  if (!res) return authWorkerUnavailable("Unable to reset password");

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
