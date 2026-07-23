import { proxyWorker } from "@/lib/api/proxy";
import { handleManualDispatchPreflight } from "../../../../../handler";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; nodeId: string }> },
) {
  return handleManualDispatchPreflight(req, { params }, proxyWorker);
}
