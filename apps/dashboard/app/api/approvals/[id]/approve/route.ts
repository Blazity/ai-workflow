import { proxyWorker } from "@/lib/api/proxy";
import { handleApprovalApprove } from "../../handler";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleApprovalApprove({ params }, proxyWorker);
}
