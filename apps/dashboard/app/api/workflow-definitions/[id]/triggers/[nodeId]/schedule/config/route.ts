import { proxyWorker } from "@/lib/api/proxy";
import { handleScheduleConfig } from "../../../../../handler";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; nodeId: string }> },
) {
  return handleScheduleConfig({ params }, proxyWorker);
}
