import { NextResponse } from "next/server";
import { cookies } from "next/headers";

const BASE = process.env.WORKER_BASE_URL ?? "";
const WORKER_TIMEOUT_MS = 10_000;

export async function POST() {
  const jar = await cookies();
  const token = jar.get("ba_session")?.value;
  try {
    if (token) {
      await fetch(`${BASE}/api/auth/sign-out`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
      }).catch(() => {
        // Best-effort worker sign-out; we clear the cookie regardless.
      });
    }
  } finally {
    jar.delete("ba_session");
  }
  return NextResponse.json({ ok: true });
}
