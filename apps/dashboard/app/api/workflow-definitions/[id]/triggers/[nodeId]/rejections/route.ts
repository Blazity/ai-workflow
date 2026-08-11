import { proxyWorker } from "@/lib/api/proxy";
import { handleTriggerRejections } from "../../../../handler";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; nodeId: string }> },
) {
  return handleTriggerRejections({ params }, proxyWorker);
}
