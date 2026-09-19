import { proxyWorker } from "@/lib/api/proxy";
import { handleIntegrationEnabledPatch } from "../../handler";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleIntegrationEnabledPatch((await params).id, request, proxyWorker);
}
