import { NextResponse } from "next/server";

import { setSessionCookie } from "@/lib/auth/session-cookie";
import { postAuthWorkerJson, readWorkerJson } from "@/lib/auth/worker";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const handoffToken = url.searchParams.get("token");
  if (!handoffToken) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const res = await postAuthWorkerJson("/api/dashboard-auth/sso/consume", {
    token: handoffToken,
  });
  if (!res?.ok) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const body = await readWorkerJson<{ sessionToken?: string }>(res);
  const sessionToken = body.sessionToken?.trim();
  if (!sessionToken) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  await setSessionCookie(sessionToken);
  return NextResponse.redirect(new URL("/", req.url));
}
