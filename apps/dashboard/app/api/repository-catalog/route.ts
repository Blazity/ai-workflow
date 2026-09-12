import { proxyWorker } from "@/lib/api/proxy";
import { handleCatalogList } from "./handler";

export function GET() {
  return handleCatalogList(proxyWorker);
}
