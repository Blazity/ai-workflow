import { proxyWorker } from "@/lib/api/proxy";
import { handleWorkScopeEdit, handleWorkScopeGet } from "../handler";

export async function GET(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  return handleWorkScopeGet(request, context, proxyWorker);
}

export async function PATCH(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  return handleWorkScopeEdit(request, context, proxyWorker);
}
