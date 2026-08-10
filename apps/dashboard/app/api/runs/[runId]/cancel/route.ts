import { proxyWorker } from "@/lib/api/proxy";
import { handleRunCancelPost } from "../../replay-handler";

export async function POST(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  return handleRunCancelPost(context, proxyWorker);
}
