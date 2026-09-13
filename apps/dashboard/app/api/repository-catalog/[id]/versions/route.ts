import { proxyWorker } from "@/lib/api/proxy";
import { handleCatalogVersionsGet } from "../../handler";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const before = new URL(request.url).searchParams.get("before");
  return handleCatalogVersionsGet((await params).id, before, proxyWorker);
}
