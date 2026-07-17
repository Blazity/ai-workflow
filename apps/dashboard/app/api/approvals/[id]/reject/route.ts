import { proxyWorker } from "@/lib/api/proxy";
import { handleApprovalReject } from "../../handler";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleApprovalReject({ params }, proxyWorker);
}
