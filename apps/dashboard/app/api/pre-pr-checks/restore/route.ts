import { proxyWorker } from "@/lib/api/proxy";
import { handlePrePrChecksRestore } from "../handler";

export async function POST(req: Request) {
  return handlePrePrChecksRestore(req, proxyWorker);
}
