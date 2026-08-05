import { proxyWorker } from "@/lib/api/proxy";
import { handleWebhookDeliveries } from "../../../../../handler";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; nodeId: string }> },
) {
  return handleWebhookDeliveries({ params }, proxyWorker);
}
