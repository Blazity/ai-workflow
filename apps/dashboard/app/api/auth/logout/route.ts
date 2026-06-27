import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { fetchAuthWorker } from "@/lib/auth/worker";

export async function POST() {
  const jar = await cookies();
  const token = jar.get("ba_session")?.value;
  try {
    if (token) {
      await fetchAuthWorker("/api/auth/sign-out", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  } finally {
    jar.delete("ba_session");
  }
  return NextResponse.json({ ok: true });
}
