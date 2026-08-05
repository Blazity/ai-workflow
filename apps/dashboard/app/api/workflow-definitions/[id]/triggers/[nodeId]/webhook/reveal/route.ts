import { proxyWorker } from "@/lib/api/proxy";
import { handleWebhookReveal } from "../../../../../handler";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; nodeId: string }> },
) {
  return handleWebhookReveal(req, { params }, proxyWorker);
}
