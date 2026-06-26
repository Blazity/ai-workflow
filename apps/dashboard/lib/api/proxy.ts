import "server-only";
import { cookies } from "next/headers";

const BASE = process.env.WORKER_BASE_URL ?? "";

export async function proxyWorker(path: string, init: RequestInit = {}): Promise<Response> {
  const jar = await cookies();
  const session = jar.get("ba_session")?.value;
  const headers = new Headers(init.headers);
  if (session) headers.set("authorization", `Bearer ${session}`);

  return fetch(`${BASE}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });
}
