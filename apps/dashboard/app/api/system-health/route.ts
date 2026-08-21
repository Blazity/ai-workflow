import { proxyWorker } from "@/lib/api/proxy";
import { handleSystemHealthScan } from "./handler";

export async function POST() {
  return handleSystemHealthScan(proxyWorker);
}
