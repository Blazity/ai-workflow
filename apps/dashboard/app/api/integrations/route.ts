import { proxyWorker } from "@/lib/api/proxy";
import { handleIntegrationsList } from "./handler";

export function GET() {
  return handleIntegrationsList(proxyWorker);
}
