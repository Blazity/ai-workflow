import { proxyWorker } from "@/lib/api/proxy";
import { handleScheduleResume } from "../../../../../handler";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; nodeId: string }> },
) {
  return handleScheduleResume(req, { params }, proxyWorker);
}
