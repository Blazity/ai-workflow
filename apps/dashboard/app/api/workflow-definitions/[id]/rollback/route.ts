import { proxyWorker } from "@/lib/api/proxy";
import { handleDefinitionRollback } from "../../handler";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleDefinitionRollback(req, { params }, proxyWorker);
}
