import { proxyWorker } from "@/lib/api/proxy";
import { handleRunAttemptGet } from "../../../replay-handler";

export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string; attemptId: string }> },
) {
  return handleRunAttemptGet(context, proxyWorker);
}
