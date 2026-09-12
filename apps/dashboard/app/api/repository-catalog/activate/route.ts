import { proxyWorker } from "@/lib/api/proxy";
import { handleCatalogActivate } from "../handler";

export function POST(request: Request) {
  return handleCatalogActivate(request, proxyWorker);
}
