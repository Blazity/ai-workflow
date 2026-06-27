import { NextResponse } from "next/server";

import {
  authWorkerUnavailable,
  postAuthWorkerJson,
  readJsonBody,
} from "@/lib/auth/worker";

export async function POST(req: Request) {
  const body = await readJsonBody<{ email?: string }>(req);

  const { email } = body;
  if (!email) {
    return NextResponse.json({ error: "Email required" }, { status: 400 });
  }

  const res = await postAuthWorkerJson("/api/auth/request-password-reset", { email });
  if (!res) return authWorkerUnavailable("Unable to send reset link");

  if (!res.ok) {
    return NextResponse.json(
      { error: "Unable to send reset link" },
      { status: res.status >= 500 ? 502 : res.status },
    );
  }

  return NextResponse.json({ ok: true });
}
