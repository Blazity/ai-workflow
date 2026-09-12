import { proxyWorker } from "@/lib/api/proxy";
import { handleCatalogVersionsGet } from "../../handler";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleCatalogVersionsGet((await params).id, proxyWorker);
}
