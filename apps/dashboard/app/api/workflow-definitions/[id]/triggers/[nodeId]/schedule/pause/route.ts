import { proxyWorker } from "@/lib/api/proxy";
import { handleSchedulePause } from "../../../../../handler";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; nodeId: string }> },
) {
  return handleSchedulePause(req, { params }, proxyWorker);
}
