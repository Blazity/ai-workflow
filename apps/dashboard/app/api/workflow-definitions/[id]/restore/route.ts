import { proxyWorker } from "@/lib/api/proxy";
import { handleDefinitionRestore } from "../../handler";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleDefinitionRestore(req, { params }, proxyWorker);
}
