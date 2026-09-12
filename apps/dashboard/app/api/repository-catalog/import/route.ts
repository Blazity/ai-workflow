import { proxyWorker } from "@/lib/api/proxy";
import { handleCatalogImport } from "../handler";

export function POST(request: Request) {
  return handleCatalogImport(request, proxyWorker);
}
