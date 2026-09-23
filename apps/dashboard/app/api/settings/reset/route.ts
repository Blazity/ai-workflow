import { proxyWorker } from "@/lib/api/proxy";
import { handleSettingsReset } from "../handler";

export function POST(request: Request) {
  return handleSettingsReset(request, proxyWorker);
}
