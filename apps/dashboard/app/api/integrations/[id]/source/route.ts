import { proxyWorker } from "@/lib/api/proxy";
import { handleIntegrationSourcePatch } from "../../handler";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleIntegrationSourcePatch((await params).id, request, proxyWorker);
}
