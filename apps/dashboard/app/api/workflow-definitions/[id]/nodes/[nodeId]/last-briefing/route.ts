import { proxyWorker } from "@/lib/api/proxy";
import { handleNodeLastBriefing } from "../../../../handler";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; nodeId: string }> },
) {
  return handleNodeLastBriefing({ params }, proxyWorker);
}
