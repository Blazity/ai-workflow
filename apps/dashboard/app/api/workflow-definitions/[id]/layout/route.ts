import { proxyWorker } from "@/lib/api/proxy";
import { handleDefinitionLayout } from "../../handler";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleDefinitionLayout(req, { params }, proxyWorker);
}
