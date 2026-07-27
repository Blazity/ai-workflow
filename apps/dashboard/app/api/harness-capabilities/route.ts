import { proxyWorker } from "@/lib/api/proxy";
import { handleHarnessCapabilitiesGet } from "./handler";

export function GET(request: Request) {
  return handleHarnessCapabilitiesGet(request, proxyWorker);
}
