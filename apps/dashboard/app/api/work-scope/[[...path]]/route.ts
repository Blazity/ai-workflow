import { proxyWorker } from "@/lib/api/proxy";
import { handleWorkScopeGet } from "../handler";

export async function GET(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  return handleWorkScopeGet(request, context, proxyWorker);
}
