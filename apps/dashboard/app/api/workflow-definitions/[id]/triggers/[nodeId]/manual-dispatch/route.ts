import { proxyWorker } from "@/lib/api/proxy";
import { handleManualDispatch } from "../../../../handler";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; nodeId: string }> },
) {
  return handleManualDispatch(req, { params }, proxyWorker);
}
