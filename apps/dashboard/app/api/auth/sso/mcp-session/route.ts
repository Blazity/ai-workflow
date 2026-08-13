import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { fetchAuthWorker, readWorkerJson } from "@/lib/auth/worker";
import { workerUrl } from "@/lib/auth/worker-core";

const OPAQUE_HANDOFF_TOKEN = /^[A-Za-z0-9_-]{20,256}$/;

/**
 * Turn the dashboard's local session into a worker session for an MCP browser
 * flow. The session is sent only server-to-server; the browser sees only the
 * one-time token returned by Better Auth.
 */
export async function GET(req: Request) {
  const workerLogin = workerLoginUrl();
  if (!workerLogin) return redirectNoStore(new URL("/login", req.url));

  const sessionToken = (await cookies()).get("ba_session")?.value;
  if (!sessionToken) return redirectNoStore(workerLogin);

  const response = await fetchAuthWorker("/api/dashboard-auth/sso/mcp-session", {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  if (!response?.ok) return redirectNoStore(workerLogin);

  const body = await readWorkerJson<{ token?: unknown }>(response);
  if (typeof body.token !== "string" || !OPAQUE_HANDOFF_TOKEN.test(body.token)) {
    return redirectNoStore(workerLogin);
  }

  const handoff = new URL(workerLogin);
  handoff.searchParams.delete("fallback");
  handoff.searchParams.set("handoff", body.token);
  return redirectNoStore(handoff);
}

function redirectNoStore(url: URL): NextResponse {
  return NextResponse.redirect(url, { headers: { "cache-control": "no-store" } });
}

function workerLoginUrl(): URL | null {
  try {
    const url = new URL("/mcp-auth/login", workerUrl(process.env.WORKER_BASE_URL, "/"));
    url.searchParams.set("fallback", "1");
    return url;
  } catch {
    return null;
  }
}
