import { proxyWorker } from "@/lib/api/proxy";
import { handleDefinitionValidate } from "../../handler";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleDefinitionValidate(req, { params }, proxyWorker);
}
