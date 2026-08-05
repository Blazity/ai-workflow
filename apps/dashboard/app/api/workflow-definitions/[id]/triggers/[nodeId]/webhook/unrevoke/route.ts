import { proxyWorker } from "@/lib/api/proxy";
import { handleWebhookUnrevoke } from "../../../../../handler";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; nodeId: string }> },
) {
  return handleWebhookUnrevoke(req, { params }, proxyWorker);
}
