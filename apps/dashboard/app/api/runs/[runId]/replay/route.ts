import { proxyWorker } from "@/lib/api/proxy";
import { handleRunReplayGet } from "../../replay-handler";

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  return handleRunReplayGet(request, context, proxyWorker);
}
