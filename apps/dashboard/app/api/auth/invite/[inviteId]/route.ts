import { NextResponse } from "next/server";

import {
  authWorkerUnavailable,
  fetchAuthWorker,
  readWorkerJson,
} from "@/lib/auth/worker";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ inviteId?: string }> },
) {
  const { inviteId } = await params;
  if (!inviteId) {
    return NextResponse.json({ error: "Invite id required" }, { status: 400 });
  }

  const res = await fetchAuthWorker(
    `/api/dashboard-auth/invite/${encodeURIComponent(inviteId)}`,
  );
  if (!res) return authWorkerUnavailable("Unable to load invite");

  return NextResponse.json(await readWorkerJson(res), { status: res.status });
}
