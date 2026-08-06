import { proxyWorker } from "@/lib/api/proxy";
import { handleWebhookSetSecret } from "../../../../../handler";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; nodeId: string }> },
) {
  return handleWebhookSetSecret(req, { params }, proxyWorker);
}
