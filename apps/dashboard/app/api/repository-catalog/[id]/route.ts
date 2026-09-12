import { proxyWorker } from "@/lib/api/proxy";
import { handleCatalogEntryGet, handleCatalogEntryPut } from "../handler";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleCatalogEntryGet((await params).id, proxyWorker);
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleCatalogEntryPut((await params).id, request, proxyWorker);
}
