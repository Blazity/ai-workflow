import { proxyWorker } from "@/lib/api/proxy";
import { handlePrePrChecksGet, handlePrePrChecksPut } from "./handler";

export async function GET() {
  return handlePrePrChecksGet(proxyWorker);
}

export async function PUT(req: Request) {
  return handlePrePrChecksPut(req, proxyWorker);
}
