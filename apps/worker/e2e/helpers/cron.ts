import { e2eEnv } from "../env.js";

function bypassHeaders(): Record<string, string> {
  const secret = e2eEnv.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (!secret) return {};
  return { "x-vercel-protection-bypass": secret };
}

export async function callCronPoll(opts?: {
  omitAuth?: boolean;
}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { ...bypassHeaders() };
  if (!opts?.omitAuth) {
    headers["Authorization"] = `Bearer ${e2eEnv.CRON_SECRET}`;
  }

  const res = await fetch(`${e2eEnv.E2E_BASE_URL}/cron/poll`, {
    method: "GET",
    headers,
  });

  let body: any;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  return { status: res.status, body };
}
