import { proxyWorker } from "@/lib/api/proxy";
import { handleWorkflowDefinitionRestore } from "../handler";

export async function POST(req: Request) {
  return handleWorkflowDefinitionRestore(req, proxyWorker);
}
