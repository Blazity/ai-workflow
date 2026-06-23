import { NextResponse } from "next/server";
import { cookies } from "next/headers";

const BASE = process.env.WORKER_BASE_URL ?? "";

export async function POST() {
  const jar = await cookies();
  const token = jar.get("ba_session")?.value;
  if (token) {
    await fetch(`${BASE}/api/auth/sign-out`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {
      // Best-effort worker sign-out; we clear the cookie regardless.
    });
  }
  jar.delete("ba_session");
  return NextResponse.json({ ok: true });
}
