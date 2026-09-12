import { proxyWorker } from "@/lib/api/proxy";
import { handleCatalogEnabledPatch } from "../../handler";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleCatalogEnabledPatch((await params).id, request, proxyWorker);
}
