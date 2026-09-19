import { proxyWorker } from "@/lib/api/proxy";
import { handleBriefingsGet } from "../../../briefings-handler";

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string; path?: string[] }> },
) {
  return handleBriefingsGet(request, context, proxyWorker);
}
