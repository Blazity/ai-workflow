import { proxyWorker } from "@/lib/api/proxy";
import { handleApprovalsList } from "./handler";

export async function GET(req: Request) {
  return handleApprovalsList(req, proxyWorker);
}
