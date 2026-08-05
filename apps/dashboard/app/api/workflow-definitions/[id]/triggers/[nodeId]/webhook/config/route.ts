import { proxyWorker } from "@/lib/api/proxy";
import { handleWebhookConfig } from "../../../../../handler";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; nodeId: string }> },
) {
  return handleWebhookConfig({ params }, proxyWorker);
}
