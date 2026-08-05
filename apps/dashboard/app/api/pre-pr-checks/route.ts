import { proxyWorker } from "@/lib/api/proxy";
import { handlePrePrChecksPut } from "./handler";

export async function PUT(req: Request) {
  return handlePrePrChecksPut(req, proxyWorker);
}
