import { proxyWorker } from "@/lib/api/proxy";
import { handleWorkflowDefinitionGet, handleWorkflowDefinitionPut } from "./handler";

export async function GET() {
  return handleWorkflowDefinitionGet(proxyWorker);
}

export async function PUT(req: Request) {
  return handleWorkflowDefinitionPut(req, proxyWorker);
}
