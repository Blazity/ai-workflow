import { handleDefinitionCatalog } from "../../handler";
import { proxyWorker } from "@/lib/api/proxy";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleDefinitionCatalog(req, { params }, proxyWorker);
}
