import { NextResponse } from "next/server";

import { fetchAuthWorker, readWorkerJson } from "@/lib/auth/worker";

export async function GET() {
  const res = await fetchAuthWorker("/api/dashboard-auth/sso/status");
  if (!res?.ok) {
    return NextResponse.json({ enabled: false });
  }

  const body = await readWorkerJson<{ enabled?: unknown }>(res);
  return NextResponse.json({ enabled: body.enabled === true });
}
