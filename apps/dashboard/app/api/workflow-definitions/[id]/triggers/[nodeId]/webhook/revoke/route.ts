import { proxyWorker } from "@/lib/api/proxy";
import { handleWebhookRevoke } from "../../../../../handler";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; nodeId: string }> },
) {
  return handleWebhookRevoke(req, { params }, proxyWorker);
}
