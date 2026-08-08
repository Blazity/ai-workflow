import { proxyWorker } from "@/lib/api/proxy";
import { handleSchedulePreview } from "../../../../../handler";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; nodeId: string }> },
) {
  return handleSchedulePreview(req, { params }, proxyWorker);
}
