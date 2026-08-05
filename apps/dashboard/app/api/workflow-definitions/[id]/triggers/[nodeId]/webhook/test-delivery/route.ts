import { proxyWorker } from "@/lib/api/proxy";
import { handleWebhookTestDelivery } from "../../../../../handler";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; nodeId: string }> },
) {
  return handleWebhookTestDelivery(req, { params }, proxyWorker);
}
