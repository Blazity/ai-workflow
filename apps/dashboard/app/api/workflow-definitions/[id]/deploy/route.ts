import { proxyWorker } from "@/lib/api/proxy";
import { handleDefinitionDeploy } from "../../handler";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleDefinitionDeploy(req, { params }, proxyWorker);
}
