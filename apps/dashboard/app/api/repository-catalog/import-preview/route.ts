import { proxyWorker } from "@/lib/api/proxy";
import { handleCatalogImportPreview } from "../handler";

export function POST(request: Request) {
  return handleCatalogImportPreview(request, proxyWorker);
}
