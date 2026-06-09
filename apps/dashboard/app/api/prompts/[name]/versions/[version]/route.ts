// apps/dashboard/app/api/prompts/[name]/versions/[version]/route.ts
// Same-origin proxy so the client can lazily fetch a historical prompt-version
// body without the server-only WORKER_API_TOKEN ever reaching the browser.
import { NextResponse } from "next/server";
import { getJSON } from "@/lib/api/server";
import type { PromptVersionBodyResponse } from "@shared/contracts";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string; version: string }> },
) {
  const { name, version } = await params;
  const now = new Date().toISOString();
  const data = await getJSON<PromptVersionBodyResponse>(
    `/api/v1/prompts/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
  ).catch(() => ({ generatedAt: now, available: false, body: null }));
  return NextResponse.json(data);
}
