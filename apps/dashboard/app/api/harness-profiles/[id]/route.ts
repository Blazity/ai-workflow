import { proxyWorker } from "@/lib/api/proxy";
import {
  handleHarnessProfileGet,
  handleHarnessProfilePatch,
} from "../handler";

export function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handleHarnessProfileGet(request, context, proxyWorker);
}

export function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handleHarnessProfilePatch(request, context, proxyWorker);
}
