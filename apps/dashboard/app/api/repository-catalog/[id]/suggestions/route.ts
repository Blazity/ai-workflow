import { proxyWorker } from "@/lib/api/proxy";
import { handleCatalogSuggestionsGet } from "../../handler";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const cursor = new URL(request.url).searchParams.get("cursor");
  return handleCatalogSuggestionsGet((await params).id, cursor, proxyWorker);
}
