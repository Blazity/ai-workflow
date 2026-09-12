import { proxyWorker } from "@/lib/api/proxy";
import { handleSettingsGet, handleSettingsPatch } from "./handler";

export function GET(request: Request) {
  return handleSettingsGet(request, proxyWorker);
}

export function PATCH(request: Request) {
  return handleSettingsPatch(request, proxyWorker);
}
